import { AppShell } from '@/components/AppShell';
import { DownstreamPage } from '@/components/DataTablePage';
import { requirePageRole } from '@/lib/auth/server';

/** Historical compatibility route: /entry opened the same publish record view. */
export default async function Page() {
  const user = await requirePageRole(['admin', 'operator'], '/entry');
  return <AppShell user={user}><DownstreamPage /></AppShell>;
}
