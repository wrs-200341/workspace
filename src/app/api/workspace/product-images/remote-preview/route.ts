import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { fetchProductGalleryCover } from '@/lib/workspace/productImages';

/** Proxy a remote 8765 PID cover through the workspace server. */
export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const pid = request.nextUrl.searchParams.get('pid')?.trim() || '';
  if (!pid || pid.length > 128) return NextResponse.json({ success: false, error: 'product_pid_invalid' }, { status: 400 });
  try {
    const result = await fetchProductGalleryCover(pid);
    return new Response(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        'content-type': result.mimeType,
        'content-length': String(result.bytes.byteLength),
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'product_cover_failed' }, { status: 502 });
  }
}
