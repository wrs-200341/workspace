import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceAccounts, type WorkspaceAccount, type WorkspaceCategory } from './data';
import { getWorkspacePath } from '../storagePaths';

const filePath = () => getWorkspacePath('workspace', 'accounts.json');

type AccountCacheEntry = { mtimeMs: number; size: number; accounts: WorkspaceAccount[] };
const accountCache = new Map<string, AccountCacheEntry>();

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function read(): WorkspaceAccount[] {
  const file = filePath();
  try {
    const stat = fs.statSync(file);
    const cached = accountCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.accounts;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const accounts = Array.isArray(parsed) ? parsed as WorkspaceAccount[] : [];
    accountCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, accounts });
    return accounts;
  } catch {
    accountCache.delete(file);
    return [];
  }
}
function write(accounts: readonly WorkspaceAccount[]): void {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  const tmp = `${filePath()}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath());
  const file = filePath();
  const stat = fs.statSync(file);
  accountCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, accounts: accounts as WorkspaceAccount[] });
}

export type AccountPatch = Partial<Pick<WorkspaceAccount, 'name' | 'strategy' | 'category' | 'planStatus' | 'promptCount' | 'fileCount' | 'videoCount' | 'publishedCount'>>;

export function listStoredAccounts(filters: { ownerId?: string; category?: WorkspaceCategory } = {}): WorkspaceAccount[] {
  const base = getWorkspaceAccounts();
  const stored = read();
  const merged = [...base, ...stored].reduce<WorkspaceAccount[]>((result, account) => {
    const index = result.findIndex((item) => item.id === account.id);
    if (index >= 0) result[index] = { ...result[index], ...account };
    else result.push(account);
    return result;
  }, []);
  return merged.filter((account) => !filters.ownerId || account.ownerId === filters.ownerId).filter((account) => !filters.category || account.category === filters.category).map(clone);
}

export function createStoredAccount(input: { ownerId: string; ownerName: string; name: string; category: WorkspaceCategory; strategy?: string }): WorkspaceAccount {
  if (!input.name.trim()) throw new Error('account_name_required');
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const account: WorkspaceAccount = { id: `workspace-account-custom-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, ownerId: input.ownerId, ownerName: input.ownerName, name: input.name.trim().slice(0, 120), category: input.category, strategy: input.strategy?.trim().slice(0, 3000) || '', promptCount: 0, fileCount: 0, videoCount: 0, publishedCount: 0, updatedAt: now, planStatus: 'draft' };
  write([...read(), account]);
  return clone(account);
}

export function updateStoredAccount(id: string, patch: AccountPatch): WorkspaceAccount | null {
  const current = listStoredAccounts().find((account) => account.id === id);
  if (!current) return null;
  if (patch.category !== undefined && patch.category !== 'featured' && patch.category !== 'remix') throw new Error('invalid_category');
  if (patch.planStatus !== undefined && patch.planStatus !== 'planned' && patch.planStatus !== 'draft') throw new Error('invalid_plan_status');
  const next: WorkspaceAccount = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || current.name } : {}),
    ...(patch.strategy !== undefined ? { strategy: patch.strategy.trim().slice(0, 3000) } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.planStatus !== undefined ? { planStatus: patch.planStatus } : {}),
    ...(patch.promptCount !== undefined ? { promptCount: Math.max(0, Math.round(patch.promptCount)) } : {}),
    ...(patch.fileCount !== undefined ? { fileCount: Math.max(0, Math.round(patch.fileCount)) } : {}),
    ...(patch.videoCount !== undefined ? { videoCount: Math.max(0, Math.round(patch.videoCount)) } : {}),
    ...(patch.publishedCount !== undefined ? { publishedCount: Math.max(0, Math.round(patch.publishedCount)) } : {}),
    updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  };
  const stored = read();
  const index = stored.findIndex((account) => account.id === id);
  write(index >= 0 ? stored.map((account, itemIndex) => itemIndex === index ? next : account) : [...stored, next]);
  return clone(next);
}
