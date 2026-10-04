import { AppShell } from '@/components/AppShell';
import { PublishedVideoBoard } from '@/components/PublishedVideoBoard';
import { requirePageRole } from '@/lib/auth/server';

export default async function PublishingPage() {
  const user = await requirePageRole(['admin', 'operator'], '/publishing');
  return <AppShell user={user}><PublishedVideoBoard /></AppShell>;
}
