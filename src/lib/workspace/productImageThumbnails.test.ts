import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import { getProductImageThumbnail, PRODUCT_IMAGE_THUMBNAIL_EDGE, productImageFileVersion } from './productImageThumbnails';

const root = `D:\\all_projects\\workspace\\data\\product-image-thumbnails-test-${process.pid}`;
const previousRoot = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT; else process.env.WORKSPACE_DATA_ROOT = previousRoot;
});

async function original(name: string, width: number, height: number): Promise<string> {
  const filePath = getWorkspacePath(name);
  await sharp({ create: { width, height, channels: 3, background: '#25753b' } }).png().toFile(filePath);
  return filePath;
}

describe('product image thumbnails', () => {
  it.each([[1600, 800, 480, 240], [800, 1600, 240, 480], [50, 100, 50, 100]])(
    'preserves the complete %ix%i image aspect ratio without upscaling', async (width, height, expectedWidth, expectedHeight) => {
      const source = await original('source.png', width, height);
      const before = fs.readFileSync(source);
      const thumbnail = await getProductImageThumbnail(source);
      const metadata = await sharp(thumbnail.filePath).metadata();
      expect(metadata).toMatchObject({ format: 'webp', width: expectedWidth, height: expectedHeight });
      expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(PRODUCT_IMAGE_THUMBNAIL_EDGE);
      expect(fs.readFileSync(source)).toEqual(before);
      expect(thumbnail.filePath).not.toBe(source);
      expect(thumbnail.size).toBe(fs.statSync(thumbnail.filePath).size);
    },
  );

  it('coalesces concurrent requests and reuses the persisted derivative', async () => {
    const source = await original('source.png', 1600, 800);
    const write = vi.spyOn(fs.promises, 'writeFile');
    const thumbnails = await Promise.all(Array.from({ length: 12 }, () => getProductImageThumbnail(source)));
    expect(new Set(thumbnails.map((item) => item.filePath)).size).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await getProductImageThumbnail(source)).toEqual(thumbnails[0]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.dirname(thumbnails[0].filePath))).toHaveLength(1);
  });

  it('versions regenerated thumbnails after an original changes', async () => {
    const source = await original('source.png', 1200, 600);
    const first = await getProductImageThumbnail(source);
    await original('source.png', 600, 1200);
    const second = await getProductImageThumbnail(source);
    expect(first.filePath).not.toBe(second.filePath);
    expect(first.version).not.toBe(second.version);
    expect(second.version).toBe(productImageFileVersion(fs.statSync(source)));
    expect(await sharp(second.filePath).metadata()).toMatchObject({ width: 240, height: 480 });
  });

  it('bounds concurrent resizing work and removes failed work from the in-flight map', async () => {
    const sources = await Promise.all(Array.from({ length: 8 }, (_, index) => original(`source-${index}.png`, 800, 400)));
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    let active = 0;
    let peak = 0;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return await writeFile(...args);
      } finally {
        active -= 1;
      }
    });
    await Promise.all(sources.map((source) => getProductImageThumbnail(source)));
    expect(peak).toBeLessThanOrEqual(2);
    const broken = getWorkspacePath('broken.png');
    fs.writeFileSync(broken, 'not an image');
    await expect(getProductImageThumbnail(broken)).rejects.toThrow();
    await original('broken.png', 800, 400);
    await expect(getProductImageThumbnail(broken)).resolves.toMatchObject({ mimeType: 'image/webp' });
  });

  it('does not return a cached thumbnail when its original has been deleted', async () => {
    const source = await original('source.png', 800, 400);
    await getProductImageThumbnail(source);
    fs.unlinkSync(source);
    await expect(getProductImageThumbnail(source)).rejects.toThrow();
  });

  it('rejects a source or cache junction outside the configured workspace root', async () => {
    const outsideSource = await original('outside.png', 800, 400);
    const outsideCache = getWorkspacePath('outside-cache');
    fs.mkdirSync(outsideCache);
    process.env.WORKSPACE_DATA_ROOT = `${root}\\nested`;
    fs.mkdirSync(getWorkspacePath());
    await expect(getProductImageThumbnail(outsideSource)).rejects.toThrow('product_thumbnail_path_invalid');
    const source = await original('inside.png', 800, 400);
    fs.symlinkSync(outsideCache, getWorkspacePath('cache'), 'junction');
    await expect(getProductImageThumbnail(source)).rejects.toThrow('product_thumbnail_path_invalid');
    expect(fs.readdirSync(outsideCache)).toEqual([]);
  });
});
