import { AppShell } from '@/components/AppShell';
import { WorkspacePage } from '@/components/DataTablePage';
import { requirePageRole } from '@/lib/auth/server';

type WorkspacePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstQueryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default async function Page({ searchParams }: WorkspacePageProps) {
  const query = await searchParams;
  const createTask = firstQueryValue(query.createTask);
  const pid = firstQueryValue(query.pid).trim();
  const taskCreateIntent = createTask === '1' && /^\d{6,30}$/.test(pid);
  const returnPath = taskCreateIntent
    ? `/workspace?createTask=1&pid=${encodeURIComponent(pid)}`
    : '/workspace';
  const user = await requirePageRole(
    taskCreateIntent ? ['admin'] : ['admin', 'workspace', 'operator'],
    returnPath,
  );
  return <AppShell user={user}><WorkspacePage user={user} /></AppShell>;
}
