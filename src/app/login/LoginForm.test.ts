import { describe, expect, it } from 'vitest';
import { safeNextPath } from '@/lib/auth/policy';

describe('login redirect safety', () => {
  it('only permits same-origin absolute paths and falls back by role', () => {
    expect(safeNextPath('/workspace')).toBe('/workspace');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath(null, 'workspace')).toBe('/workspace');
    expect(safeNextPath('', 'admin')).toBe('/');
  });
});
