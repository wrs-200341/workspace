import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWorkspacePath } from '@/lib/storagePaths';
import { createSession, createUser, deleteUser, listUsers, resolveSession, updateUser } from './store';

const root = `D:\\all_projects\\workspace\\data\\auth-store-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;
const previousAdminPassword = process.env.WORKSPACE_ADMIN_PASSWORD;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  delete process.env.WORKSPACE_ADMIN_PASSWORD;
  fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = previous;
  if (previousAdminPassword === undefined) delete process.env.WORKSPACE_ADMIN_PASSWORD;
  else process.env.WORKSPACE_ADMIN_PASSWORD = previousAdminPassword;
});

describe('auth user management', () => {
  it('creates, edits role/display name/password, and deletes users', () => {
    const user = createUser({ username: 'emily', displayName: 'Emily', role: 'operator', password: 'password-12345' });
    expect(listUsers()).toEqual([user]);
    const updated = updateUser(user.id, { displayName: 'Emily Zhang', role: 'workspace', password: 'password-67890' });
    expect(updated).toMatchObject({ id: user.id, username: 'emily', displayName: 'Emily Zhang', role: 'workspace' });
    expect(deleteUser(user.id)).toMatchObject({ id: user.id, username: 'emily' });
    expect(listUsers()).toEqual([]);
    expect(getWorkspacePath('auth', 'users.json').startsWith(root)).toBe(true);
  });

  it('protects the last administrator from deletion or demotion', () => {
    process.env.WORKSPACE_ADMIN_PASSWORD = 'admin-password-123';
    const admin = listUsers()[0];
    expect(() => updateUser(admin.id, { role: 'operator' })).toThrow('last_admin_cannot_demote');
    expect(() => deleteUser(admin.id)).toThrow('last_admin_cannot_delete');
  });

  it('invalidates existing sessions when a password changes', () => {
    const user = createUser({ username: 'emily', displayName: 'Emily', role: 'operator', password: 'password-12345' });
    const token = createSession(user.id);
    expect(resolveSession(token)?.id).toBe(user.id);
    updateUser(user.id, { password: 'password-67890' });
    expect(resolveSession(token)).toBeNull();
  });

  it('normalizes and limits display names', () => {
    const user = createUser({ username: 'emily', displayName: `  ${'x'.repeat(200)}  `, role: 'operator', password: 'password-12345' });
    expect(user.displayName).toHaveLength(120);
  });
});
