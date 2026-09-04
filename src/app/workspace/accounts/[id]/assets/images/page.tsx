import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { AccountAssetsPage } from '@/components/AccountAssetsPage';
import { requirePageRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) { const { id } = await params; const query = await searchParams; const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/assets/images`); if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden'); const readOnly = !canAccessWorkspaceAccount(user, id, { write: true }); const imageTab = query.tab === 'products' ? 'products' : 'materials'; return <AppShell user={user}><AccountAssetsPage accountId={id} section="image" imageTab={imageTab} readOnly={readOnly} /></AppShell>; }
