import { AppShell } from '@/components/AppShell';
import { AccountsPage } from '@/components/DataTablePage';
import { requirePageRole } from '@/lib/auth/server';
export default async function Page() { const user = await requirePageRole(['admin', 'operator'], '/accounts'); return <AppShell user={user}><AccountsPage /></AppShell>; }
