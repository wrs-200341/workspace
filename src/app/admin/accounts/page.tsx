import { AppShell } from '@/components/AppShell';
import { AccountControlPage } from '@/components/AccountControlPage';
import { requirePageRole } from '@/lib/auth/server';

export default async function Page() { const user = await requirePageRole(['admin'], '/admin/accounts'); return <AppShell user={user}><AccountControlPage /></AppShell>; }
