import { describe, expect, it } from 'vitest';
import { canAccessRole, hasPermission, landingPathForRole, routeRoles } from './policy';

describe('workspace role policy', () => {
  it('separates the three account levels', () => {
    expect(hasPermission('admin', 'account-control')).toBe(true);
    expect(hasPermission('workspace', 'account-control')).toBe(false);
    expect(hasPermission('operator', 'downstream')).toBe(true);
    expect(hasPermission('operator', 'workspace')).toBe(true);
  });

  it('checks allowed role sets without implicit elevation', () => {
    expect(canAccessRole('workspace', ['admin', 'operator'])).toBe(false);
    expect(canAccessRole('operator', ['admin', 'operator'])).toBe(true);
  });

  it('chooses a safe landing page', () => {
    expect(landingPathForRole('workspace')).toBe('/workspace');
    expect(landingPathForRole('operator')).toBe('/');
  });

  it('keeps account assets and production routes aligned with the workbench', () => {
    expect(routeRoles('/workspace/accounts/acc-001/assets')).toEqual(['admin', 'workspace', 'operator']);
    expect(routeRoles('/workspace/accounts/acc-001/assets/images')).toEqual(['admin', 'workspace', 'operator']);
    expect(routeRoles('/workspace/accounts/acc-001/assets/audio')).toEqual(['admin', 'workspace', 'operator']);
    expect(routeRoles('/workspace/accounts/acc-001/production')).toEqual(['admin', 'workspace', 'operator']);
    expect(routeRoles('/workspace/accounts/acc-001/production/video-tasks/task-1')).toEqual(['admin', 'workspace', 'operator']);
    expect(routeRoles('/workspace/accounts/acc-001/production/image-tasks/task-1?tab=review')).toEqual(['admin', 'workspace', 'operator']);
    expect(routeRoles('/admin/accounts')).toEqual(['admin']);
    expect(routeRoles('/products')).toBeUndefined();
    expect(routeRoles('/unknown')).toBeUndefined();
  });
});
