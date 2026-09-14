import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspacePath } from '../storagePaths';

export const PRODUCT_IMAGE_THUMBNAIL_EDGE = 480;
const THUMBNAIL_FORMAT_VERSION = 'webp-inside-480-v1';
const MAX_ACTIVE_THUMBNAILS = 2;
const MAX_QUEUED_THUMBNAILS = 256;
let activeThumbnails = 0;
const waiting: Array<() => void> = [];
const inFlight = new Map<string, Promise<ProductImageThumbnail>>();

export type ProductImageThumbnail = { filePath: string; size: number; mimeType: 'image/webp'; version: string };

export function productImageFileVersion(stat: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return createHash('sha256').update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex').slice(0, 24);
}

export function productImageThumbnailUrl(assetId: string, version?: string): string {
  const params = new URLSearchParams({ assetId, thumbnail: '1' });
  if (version) params.set('v', version);
  return `/api/workspace/product-images/preview?${params}`;
}

async function withThumbnailSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeThumbnails >= MAX_ACTIVE_THUMBNAILS) {
    if (waiting.length >= MAX_QUEUED_THUMBNAILS) throw new Error('product_thumbnail_busy');
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    activeThumbnails += 1;
  }
  try {
    return await operation();
  } finally {
    const next = waiting.shift();
    if (next) next(); else activeThumbnails -= 1;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function cachedThumbnail(filePath: string, cacheRoot: string, version: string): Promise<ProductImageThumbnail | null> {
  try {
    const real = await fs.realpath(filePath);
    if (!isWithin(cacheRoot, real)) throw new Error('product_thumbnail_path_invalid');
    const stat = await fs.stat(real);
    return stat.isFile() && stat.size > 0 ? { filePath: real, size: stat.size, mimeType: 'image/webp', version } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function privateCacheRoot(workspaceRoot: string): Promise<string> {
  let directory = workspaceRoot;
  for (const segment of ['cache', 'product-image-thumbnails']) {
    directory = path.join(directory, segment);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    directory = await fs.realpath(directory);
    if (!isWithin(workspaceRoot, directory)) throw new Error('product_thumbnail_path_invalid');
  }
  return directory;
}

/** The caller must authorize and resolve the original before requesting a derivative. */
export async function getProductImageThumbnail(sourcePath: string): Promise<ProductImageThumbnail> {
  const workspaceRoot = await fs.realpath(getWorkspacePath());
  const realSource = await fs.realpath(sourcePath);
  if (!isWithin(workspaceRoot, realSource)) throw new Error('product_thumbnail_path_invalid');
  const sourceStat = await fs.stat(realSource);
  if (!sourceStat.isFile() || !sourceStat.size) throw new Error('reference_asset_not_found');
  const version = productImageFileVersion(sourceStat);
  const cachePath = getWorkspacePath('cache', 'product-image-thumbnails');
  const key = createHash('sha256').update(`${realSource}:${version}:${THUMBNAIL_FORMAT_VERSION}`).digest('hex');
  const outputPath = path.join(cachePath, `${key}.webp`);
  const existing = inFlight.get(outputPath);
  if (existing) return existing;

  const pending = (async () => {
    const cacheRoot = await privateCacheRoot(workspaceRoot);
    const cached = await cachedThumbnail(outputPath, cacheRoot, version);
    if (cached) return cached;
    return withThumbnailSlot(async () => {
      const { default: sharp } = await import('sharp');
      // Retained libvips file handles prevent later imports/cleanup on Windows.
      sharp.cache({ files: 0 });
      const bytes = await sharp(realSource, { animated: false, limitInputPixels: 100_000_000 })
        .rotate()
        .resize({ width: PRODUCT_IMAGE_THUMBNAIL_EDGE, height: PRODUCT_IMAGE_THUMBNAIL_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78, effort: 3 })
        .toBuffer()
        .catch((error: unknown) => {
          if (error instanceof Error && /unsupported image format|unsupported codec|no decode delegate/i.test(error.message)) {
            throw new Error('product_thumbnail_format_unsupported');
          }
          throw error;
        });
      // Do not label bytes from a concurrently replaced import with its old version.
      if (productImageFileVersion(await fs.stat(realSource)) !== version) throw new Error('product_thumbnail_source_changed');
      const temporaryPath = path.join(cacheRoot, `${key}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
        try {
          await fs.rename(temporaryPath, path.join(cacheRoot, `${key}.webp`));
        } catch (error) {
          // Another server process may have completed the same immutable file.
          if (!await cachedThumbnail(outputPath, cacheRoot, version)) throw error;
        }
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
      const result = await cachedThumbnail(outputPath, cacheRoot, version);
      if (!result) throw new Error('product_thumbnail_failed');
      return result;
    });
  })();
  inFlight.set(outputPath, pending);
  try {
    return await pending;
  } finally {
    if (inFlight.get(outputPath) === pending) inFlight.delete(outputPath);
  }
}
