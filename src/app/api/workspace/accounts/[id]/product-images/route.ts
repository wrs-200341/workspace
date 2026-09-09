import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { importProductImages, listProductImageFolders, listProductImages, queryProductGallery, readProductImageFolder, scheduleProductImageCleanup } from '@/lib/workspace/productImages';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  scheduleProductImageCleanup();
  try {
    const query = request.nextUrl.searchParams.get('query')?.trim();
    const limit = boundedInteger(request.nextUrl.searchParams.get('limit'), 50, 1, 100);
    const offset = boundedInteger(request.nextUrl.searchParams.get('offset'), 0, 0, 1_000_000);
    const pid = request.nextUrl.searchParams.get('pid')?.trim() || '';
    const gallery = query || request.nextUrl.searchParams.has('source')
      ? await queryProductGallery({ query, membership: request.nextUrl.searchParams.get('membership') || undefined, category: request.nextUrl.searchParams.get('category') || undefined, limit, offset })
      : undefined;
    const normalizedGallery = gallery?.map((item) => item.coverUrl
      ? { ...item, coverUrl: `/api/workspace/product-images/remote-preview?pid=${encodeURIComponent(item.pid)}` }
      : item);
    const imported = listProductImages();
    // Shared product gallery: folder detail lookups are global, not per-account.
    const folders = pid ? readProductImageFolder(undefined, pid) : undefined;
    const folderList = listProductImageFolders(undefined);
    return NextResponse.json({ success: true, data: { accountId: id, imported, folders: folderList, ...(folders ? { folder: folders } : {}), ...(normalizedGallery ? { gallery: normalizedGallery } : {}) } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'product_gallery_failed' }, { status: 502 });
  }
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
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
    const imported = await importProductImages(id, body.pids);
    return NextResponse.json({ success: true, data: { accountId: id, imported } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'product_import_failed' }, { status: 400 });
  }
}
