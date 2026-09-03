import { AppShell } from '@/components/AppShell';
import { DownstreamPage } from '@/components/DataTablePage';
import { requirePageRole } from '@/lib/auth/server';
export default async function Page() { const user = await requirePageRole(['admin', 'operator'], '/records'); return <AppShell user={user}><DownstreamPage /></AppShell>; }
