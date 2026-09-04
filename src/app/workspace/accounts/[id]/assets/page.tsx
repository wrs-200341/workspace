import { AppShell } from '@/components/AppShell';
import { AccountAssetsPage } from '@/components/AccountAssetsPage';
import { requirePageRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { redirect } from 'next/navigation';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ section?: string; tab?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/assets`);
  if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden');
  const readOnly = !canAccessWorkspaceAccount(user, id, { write: true });
  const section = query.section === 'image' || query.section === 'inventory-video' || query.section === 'audio' ? query.section : 'prompt';
  const imageTab = query.tab === 'products' ? 'products' : 'materials';
  const promptTab = query.tab === 'image' ? 'image' : 'video';
  return <AppShell user={user}><AccountAssetsPage accountId={id} section={section} imageTab={imageTab} promptTab={promptTab} readOnly={readOnly} /></AppShell>;
}
