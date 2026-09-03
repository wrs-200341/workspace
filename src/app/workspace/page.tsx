import { AppShell } from '@/components/AppShell';
import { WorkspacePage } from '@/components/DataTablePage';
import { requirePageRole } from '@/lib/auth/server';
export default async function Page() { const user = await requirePageRole(['admin', 'workspace', 'operator'], '/workspace'); return <AppShell user={user}><WorkspacePage user={user} /></AppShell>; }
