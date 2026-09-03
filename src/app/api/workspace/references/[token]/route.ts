import { NextRequest, NextResponse } from 'next/server';
import { readPublicReference } from '@/lib/workspace/referenceBridge';

function responseFor(token: string): Response {
  const reference = readPublicReference(token);
  if (!reference) return NextResponse.json({ success: false, error: 'reference_not_found' }, { status: 404 });
  const headers = new Headers({
    'content-type': reference.mimeType,
    'content-length': String(reference.bytes.byteLength),
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  });
  return new Response(new Uint8Array(reference.bytes), { status: 200, headers });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return responseFor(token);
}

export async function HEAD(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const response = responseFor(token);
  return new Response(null, { status: response.status, headers: response.headers });
}
