import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { importProductImages, listProductImages, queryProductGallery, scheduleProductImageCleanup } from '@/lib/workspace/productImages';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  scheduleProductImageCleanup();
  try {
    const query = request.nextUrl.searchParams.get('query')?.trim();
    const gallery = query || request.nextUrl.searchParams.has('source')
      ? await queryProductGallery({ query, membership: request.nextUrl.searchParams.get('membership') || undefined, category: request.nextUrl.searchParams.get('category') || undefined, limit: Number(request.nextUrl.searchParams.get('limit') || 50), offset: Number(request.nextUrl.searchParams.get('offset') || 0) })
      : undefined;
    // Imported product images are shared across all operator workspaces. The
    // account id is retained only as the importing workspace for audit and
    // storage layout; every production form reads the global gallery.
    return NextResponse.json({ success: true, data: { accountId: id, imported: listProductImages(), ...(gallery ? { gallery } : {}) } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'product_gallery_failed' }, { status: 502 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { pids?: unknown };
  if (!Array.isArray(body.pids) || !body.pids.every((pid) => typeof pid === 'string')) return NextResponse.json({ success: false, error: 'product_pid_required' }, { status: 400 });
  scheduleProductImageCleanup();
  try {
    // Product images are a shared library. Keep new PID downloads under one
    // shared storage namespace instead of duplicating them per operator.
    const imported = await importProductImages('shared', body.pids);
    return NextResponse.json({ success: true, data: { accountId: id, imported } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'product_import_failed' }, { status: 400 });
  }
}
