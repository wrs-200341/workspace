import { AppShell } from '@/components/AppShell';
import { DashboardPage } from '@/components/DashboardPage';
import { requirePageRole } from '@/lib/auth/server';

export default async function HomePage() { const user = await requirePageRole(['admin', 'operator'], '/'); return <AppShell user={user}><DashboardPage /></AppShell>; }
