import { AppShell } from '@/components/AppShell';
import { GenerationStatsPage } from '@/components/GenerationStatsPage';
import { requirePageRole } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; range?: string }> }) {
  const user = await requirePageRole(['admin'], '/generation-stats');
  const filters = await searchParams;
  return <AppShell user={user}><GenerationStatsPage filters={filters} /></AppShell>;
}
