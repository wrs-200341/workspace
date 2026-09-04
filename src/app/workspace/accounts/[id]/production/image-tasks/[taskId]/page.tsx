import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { TaskReviewPage } from '@/components/TaskReviewPage';
import { requirePageRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';

export default async function Page({ params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params;
  const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/production/image-tasks/${taskId}`);
  if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden');
  const readOnly = !canAccessWorkspaceAccount(user, id, { write: true });
  return <AppShell user={user}><TaskReviewPage accountId={id} taskId={taskId} mode="image" readOnly={readOnly} /></AppShell>;
}
