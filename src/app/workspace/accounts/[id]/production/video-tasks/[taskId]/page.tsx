import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { TaskReviewPage } from '@/components/TaskReviewPage';
import { requirePageRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';

export default async function Page({ params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params;
  const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/production/video-tasks/${taskId}`);
  if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden');
  return <AppShell user={user}><TaskReviewPage accountId={id} taskId={taskId} mode="video" /></AppShell>;
}
