import { describe, expect, it } from 'vitest';
import { getProviderCatalog, getProviderConfig, isLiveProviderEnabled, isLiveProvidersAllowed, isProviderLiveEnabled, validateProviderUrl } from './config';

describe('provider configuration safety', () => {
  it('exposes catalog without requiring secrets', () => {
    expect(getProviderCatalog().map((provider) => provider.id)).toEqual(expect.arrayContaining(['grok-video', 'mgrouter-grok-image', 'mgrouter-grok-video', 'wan3-video', 'minimax-h3', 'yuanai-gemini-prompt', 'yuanai-image', 'pomoai-gemini-image', 'gpt-2999-prompt', 'oairegbox-omni']));
    expect(isLiveProviderEnabled()).toBe(false);
    expect(isLiveProvidersAllowed()).toBe(false);
    expect(isProviderLiveEnabled('grok-video')).toBe(false);
    expect(isProviderLiveEnabled('minimax-h3')).toBe(false);
  });

  it('allows only exact provider origins', () => {
    expect(validateProviderUrl('grok-video', 'https://snumom.com/v1/videos')).toBe(true);
    expect(validateProviderUrl('grok-video', 'https://evil.example/v1/videos')).toBe(false);
    expect(validateProviderUrl('mgrouter-grok-image', 'https://raw.mgrouter.com/v1/images/generations')).toBe(true);
    expect(validateProviderUrl('wan3-video', 'https://api.manjuai.top/v1/videos/generations')).toBe(true);
    expect(validateProviderUrl('wan3-video', 'http://api.manjuai.top/v1/videos/generations')).toBe(false);
    expect(validateProviderUrl('minimax-h3', 'https://api.manjuai.top/v1/videos/generations')).toBe(true);
  });

  it('returns safe defaults and never exposes keys', () => {
    const config = getProviderConfig('grok-video');
    expect(config.baseUrl).toBe('https://snumom.com/v1');
    expect(config.apiKey).toBeUndefined();
    expect(Object.keys(config)).not.toContain('authorization');
    expect(getProviderConfig('mgrouter-grok-video').model).toBe('grok-imagine-video-1.5');
  });
});
