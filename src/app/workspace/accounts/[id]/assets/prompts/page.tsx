import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { AccountAssetsPage } from '@/components/AccountAssetsPage';
import { requirePageRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) { const { id } = await params; const query = await searchParams; const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/assets/prompts`); if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden'); const promptTab = query.tab === 'image' ? 'image' : 'video'; return <AppShell user={user}><AccountAssetsPage accountId={id} section="prompt" promptTab={promptTab} /></AppShell>; }
