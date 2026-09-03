import { describe, expect, it } from 'vitest';
import { getWorkspaceAccounts, getWorkspaceOperatorForUser, getWorkspaceOperators } from './data';

describe('workspace account catalog', () => {
  it('exposes the six historical operator slots', () => {
    expect(getWorkspaceOperators()).toHaveLength(6);
    expect(getWorkspaceOperators().every((operator) => operator.username.length > 2)).toBe(true);
  });

  it('filters accounts by owner and category without mutating the catalog', () => {
    const all = getWorkspaceAccounts();
    const owner = all[0].ownerId;
    const filtered = getWorkspaceAccounts({ ownerId: owner, category: 'featured' });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((account) => account.ownerId === owner && account.category === 'featured')).toBe(true);
    expect(getWorkspaceAccounts()).toHaveLength(all.length);
  });

  it('creates a stable owner lane for a newly-created operator user', () => {
    expect(getWorkspaceOperatorForUser('emily', 'Emily')).toEqual({
      id: 'operator-emily', username: 'emily', name: 'Emily', accountCount: 0,
    });
  });
});
