import { describe, expect, it } from 'vitest';
import { matchesAssetPidPrefix } from './assetPidSearch';

describe('asset PID prefix search', () => {
  it('matches image and video inventory names by PID prefix', () => {
    expect(matchesAssetPidPrefix('1737129686300787875-4_2026-09-14_1.png', '173712')).toBe(true);
    expect(matchesAssetPidPrefix('1737129686300787875_001_2026-09-14_1.mp4', '1737129686300787875')).toBe(true);
    expect(matchesAssetPidPrefix('1737129686300787875_001.mp4', '173713')).toBe(false);
  });

  it('trims input and compares case-insensitively', () => {
    expect(matchesAssetPidPrefix('ABC-001.webp', '  abc ')).toBe(true);
    expect(matchesAssetPidPrefix('ABC-001.webp', '')).toBe(true);
  });
});
