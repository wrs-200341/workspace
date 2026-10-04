import { describe, expect, it } from 'vitest';
import { parseHttpByteRange } from './httpByteRange';

describe('parseHttpByteRange', () => {
  it('parses bounded and open-ended ranges', () => {
    expect(parseHttpByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseHttpByteRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseHttpByteRange('bytes=7-99', 10)).toEqual({ start: 7, end: 9 });
  });

  it('maps suffix ranges to the final bytes of the resource', () => {
    expect(parseHttpByteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseHttpByteRange('bytes=-99', 10)).toEqual({ start: 0, end: 9 });
  });

  it.each(['bytes=-0', 'bytes=-', 'bytes=10-', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1'])('rejects invalid or unsupported range %s', (value) => {
    expect(parseHttpByteRange(value, 10)).toBeNull();
  });
});
