import { describe, expect, it } from 'vitest';

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

describe('login redirect safety', () => {
  it('only permits same-origin absolute paths', () => {
    expect(safeNextPath('/workspace')).toBe('/workspace');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
  });
});
