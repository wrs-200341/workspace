import dns from 'node:dns/promises';
import net from 'node:net';
import { NextRequest, NextResponse } from 'next/server';
import { getProviderTask } from '@/lib/providers/taskStore';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { requireApiRole } from '@/lib/auth/server';
import { readStoredOutput, storeImageOutput } from '@/lib/providers/outputStore';

const MAX_IMAGE_OUTPUT_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25_000;

function imageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/avif') return 'avif';
  if (normalized === 'image/bmp' || normalized === 'image/x-ms-bmp') return 'bmp';
  return 'png';
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
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

async function assertPublicImageTarget(value: string): Promise<URL> {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('image_output_url_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443')) {
    throw new Error('image_output_url_invalid');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new Error('image_output_target_blocked');
  }
  const family = net.isIP(hostname);
  const addresses = family ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error('image_output_target_blocked');
  return parsed;
}

async function readLimitedBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_OUTPUT_BYTES) throw new Error('image_output_too_large');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.byteLength > MAX_IMAGE_OUTPUT_BYTES) throw new Error('image_output_invalid');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value?.byteLength) continue;
      total += next.value.byteLength;
      if (total > MAX_IMAGE_OUTPUT_BYTES) throw new Error('image_output_too_large');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (!total) throw new Error('image_output_invalid');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif' | 'image/bmp' | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(new TextDecoder().decode(bytes.slice(0, 6)))) return 'image/gif';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp' && ['avif', 'avis'].includes(new TextDecoder().decode(bytes.slice(8, 12)))) return 'image/avif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

async function readRemoteImage(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const parsed = await assertPublicImageTarget(url);
  const response = await fetch(parsed.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('image_output_fetch_failed');
  const declaredType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const bytes = await readLimitedBytes(response);
  const sniffedType = sniffImageMime(bytes);
  if (!sniffedType || !declaredType.startsWith('image/') || declaredType !== sniffedType) throw new Error('image_output_invalid');
  return { bytes, mimeType: sniffedType };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string; index: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId, index: rawIndex } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'image') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index > 63) return NextResponse.json({ success: false, error: 'output_not_found' }, { status: 404 });
  const disposition = request.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline';
  const output = readStoredOutput(id, taskId, index);
  if (output) {
    const safeTaskId = /^[a-zA-Z0-9_-]+$/.test(taskId) ? taskId : 'task';
    return new NextResponse(Buffer.from(output.bytes), {
      status: 200,
      headers: {
        'content-type': output.mimeType,
        'cache-control': 'private, max-age=3600',
        'content-length': String(output.bytes.length),
        'content-disposition': `${disposition}; filename="workspace-${safeTaskId}-${index + 1}.${imageExtension(output.mimeType)}"`,
      },
    });
  }
  const remoteUrl = task.outputUrls[index];
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) return NextResponse.json({ success: false, error: 'output_not_found' }, { status: 404 });
  try {
    const remote = await readRemoteImage(remoteUrl);
    // Keep the response path usable with older deployments that do not yet
    // expose the optional local image cache helper.
    storeImageOutput?.(id, taskId, index, Buffer.from(remote.bytes), remote.mimeType);
    const safeTaskId = /^[a-zA-Z0-9_-]+$/.test(taskId) ? taskId : 'task';
    return new NextResponse(Buffer.from(remote.bytes), {
      status: 200,
      headers: {
        'content-type': remote.mimeType,
        'cache-control': 'private, max-age=3600',
        'content-length': String(remote.bytes.byteLength),
        'content-disposition': `${disposition}; filename="workspace-${safeTaskId}-${index + 1}.${imageExtension(remote.mimeType)}"`,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const safeError = ['image_output_url_invalid', 'image_output_target_blocked', 'image_output_fetch_failed', 'image_output_invalid', 'image_output_too_large'].includes(code)
      ? code
      : 'image_output_fetch_failed';
    return NextResponse.json({ success: false, error: safeError }, { status: 502 });
  }
}
