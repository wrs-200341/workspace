import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { createUploadedAsset, type WorkspaceAsset } from './assetStore';

/**
 * Maximum URL length accepted by the importer.  WeChat image URLs contain a
 * long `skey` query value, but do not need to approach a server's URL limit.
 */
const MAX_URL_LENGTH = 16 * 1024;
const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

type LookupAddress = { address: string; family: number };
type ImportDependencies = {
  fetcher?: typeof fetch;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
};

/**
 * Normalise a common copy/paste error from the WeChat file helper endpoint:
 * `.../webwxgetmsgimg??&MsgID=...`.
 *
 * Only a second question mark immediately after the path delimiter is
 * removed.  Question marks occurring later in the query are left untouched,
 * and the complete query string (including `MsgID`/`skey`) is retained.
 */
export function normalizeExternalImageUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > MAX_URL_LENGTH) throw new Error('image_url_invalid');
  const firstQuestion = value.indexOf('?');
  const normalized = firstQuestion >= 0 && value[firstQuestion + 1] === '?'
    ? `${value.slice(0, firstQuestion)}${value.slice(firstQuestion + 1)}`
    : value;
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new Error('image_url_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !parsed.hostname || (parsed.port && parsed.port !== '443')) {
    throw new Error('image_url_invalid');
  }
  return normalized;
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
      || (a >= 224);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd')
      || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')
      || lower.startsWith('ff');
  }
  return true;
}

async function assertPublicTarget(url: string, lookup: (hostname: string) => Promise<LookupAddress[]>): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443')) throw new Error('image_url_invalid');
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new Error('image_url_target_blocked');
  }
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname);
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error('image_url_target_blocked');
  return parsed;
}

async function readResponseBytes(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error('image_file_too_large');
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('image_file_empty');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('image_file_too_large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value?.byteLength) continue;
      total += next.value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error('image_file_too_large');
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error('image_file_empty');
  return Buffer.concat(chunks, total);
}

function sniffImage(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return { mimeType: 'image/png', extension: '.png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: 'image/jpeg', extension: '.jpg' };
  if (bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).startsWith('GIF8')) return { mimeType: 'image/gif', extension: '.gif' };
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return { mimeType: 'image/webp', extension: '.webp' };
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp' && ['avif', 'avis'].includes(new TextDecoder().decode(bytes.slice(8, 12)))) return { mimeType: 'image/avif', extension: '.avif' };
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return { mimeType: 'image/bmp', extension: '.bmp' };
  return null;
}

function safeFileName(value: string, extension: string): string {
  const base = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'imported-image';
  const withoutExtension = path.basename(base, path.extname(base));
  return `${withoutExtension || 'imported-image'}${extension}`;
}

function redirectUrl(response: Response, current: URL): string | null {
  const location = response.headers.get('location');
  if (!location) return null;
  try { return new URL(location, current).toString(); } catch { throw new Error('image_redirect_invalid'); }
}

/**
 * Download an external image on the server, validate it, and store it as a
 * normal account image asset below WORKSPACE_DATA_ROOT (the D-drive root).
 */
export async function importExternalImageAsset(
  accountId: string,
  inputUrl: string,
  options: { name?: string } & ImportDependencies = {},
): Promise<WorkspaceAsset> {
  const initialUrl = normalizeExternalImageUrl(inputUrl);
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true }));
  let current = await assertPublicTarget(initialUrl, lookup);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    response = await fetcher(current.toString(), {
      method: 'GET',
      headers: {
        accept: 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5',
        'user-agent': 'WorkspaceAssetImporter/1.0',
      },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirects === MAX_REDIRECTS) throw new Error('image_redirect_limit');
      const next = redirectUrl(response, current);
      if (!next) throw new Error('image_redirect_invalid');
      current = await assertPublicTarget(next, lookup);
      continue;
    }
    break;
  }
  if (!response || !response.ok) {
    if (response && (response.status === 401 || response.status === 403)) throw new Error('external_asset_auth_required');
    throw new Error(response ? `image_source_http_${response.status}` : 'image_source_failed');
  }
  const declaredType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let bytes: Buffer;
  try {
    bytes = await readResponseBytes(response);
  } catch (error) {
    // WeChat commonly returns an empty HTML response when the copied URL is
    // expired or the browser session cookie is not available to this server.
    if (error instanceof Error && error.message === 'image_file_empty' && (declaredType === 'text/html' || declaredType === 'application/json')) {
      throw new Error('external_asset_auth_required');
    }
    throw error;
  }
  const image = sniffImage(bytes);
  if (!image) {
    if (declaredType === 'text/html' || declaredType === 'application/json' || declaredType === 'text/plain') {
      throw new Error('external_asset_auth_required');
    }
    throw new Error('image_content_invalid');
  }
  if (declaredType && !declaredType.startsWith('image/') && declaredType !== 'application/octet-stream') throw new Error('image_content_type_invalid');
  const requestedName = options.name?.trim() || path.basename(current.pathname) || 'imported-image';
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return createUploadedAsset(accountId, 'image', { name: safeFileName(requestedName, image.extension), type: image.mimeType, size: bytes.length, arrayBuffer: copy.buffer });
}
