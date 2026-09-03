import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import { createStoredAccount, listStoredAccounts, updateStoredAccount } from './accountStore';

const root = `D:\\all_projects\\workspace\\data\\account-store-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;
beforeEach(() => { process.env.WORKSPACE_DATA_ROOT = root; fs.rmSync(root, { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT; else process.env.WORKSPACE_DATA_ROOT = previous; });

describe('workspace account store', () => {
  it('creates and updates a manually added account', () => {
    const account = createStoredAccount({ ownerId: 'operator-1', ownerName: 'Operator', name: 'New account', category: 'featured', strategy: 'Initial plan' });
    expect(listStoredAccounts().find((item) => item.id === account.id)?.name).toBe('New account');
    expect(updateStoredAccount(account.id, { name: 'Edited account', strategy: 'Updated plan' })?.name).toBe('Edited account');
    expect(getWorkspacePath('workspace', 'accounts.json').startsWith(root)).toBe(true);
  });
});
