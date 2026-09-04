import { describe, expect, it } from 'vitest';
import { getDefaultImageResolution, getDefaultProductionAspectRatio, getDefaultProductionDuration } from './defaults';

describe('production defaults', () => {
  it('prefers portrait output whenever the model supports 9:16', () => {
    expect(getDefaultProductionAspectRatio(['16:9', '1:1', '9:16'])).toBe('9:16');
    expect(getDefaultProductionAspectRatio(['1:1'])).toBe('1:1');
  });

  it('prefers the standard ten-second video preset', () => {
    expect(getDefaultProductionDuration([5, 8, 10, 15])).toBe(10);
    expect(getDefaultProductionDuration([5, 8])).toBe(5);
    expect(getDefaultProductionDuration([])).toBe(10);
    expect(getDefaultProductionDuration(undefined)).toBe(10);
  });

  it('prefers 4K for image models that advertise it', () => {
    expect(getDefaultImageResolution(['1k', '2k', '4k'])).toBe('4k');
    expect(getDefaultImageResolution(['1k', '2k'])).toBe('2k');
    expect(getDefaultImageResolution([])).toBe('');
  });
});
