import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { AccountAssetsPage } from '@/components/AccountAssetsPage';
import { requirePageRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/assets/audio`); if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden'); const readOnly = !canAccessWorkspaceAccount(user, id, { write: true }); return <AppShell user={user}><AccountAssetsPage accountId={id} section="audio" readOnly={readOnly} /></AppShell>; }
