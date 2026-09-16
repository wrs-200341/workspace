import { describe, expect, it } from 'vitest';
import { getProviderCatalog, getProviderConfig, isLiveProviderEnabled, isLiveProvidersAllowed, isProviderLiveEnabled, validateProviderUrl } from './config';

describe('provider configuration safety', () => {
  it('isolates the dola sd2 supplier, credentials and image-only capabilities', () => {
    const env = { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', DOLA_SD2_API_KEY: 'test-dola-key' };
    expect(getProviderCatalog().find((provider) => provider.id === 'dola-sd2')).toMatchObject({
      name: 'dola sd2 / yuansucang',
      kind: 'video',
      model: 'dola-sd2',
      baseUrl: 'https://mj.yuansucang.cn/open-api/v1',
      liveEnv: 'DOLA_SD2_API_KEY',
      supports: {
        referenceImages: 1,
        referenceVideos: 0,
        referenceAudios: 0,
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        ratios: ['9:16'],
        resolutions: ['720p'],
      },
    });
    expect(getProviderConfig('dola-sd2', env).apiKey).toBe('test-dola-key');
    expect(isProviderLiveEnabled('dola-sd2', env)).toBe(true);
    expect(isLiveProviderEnabled(env)).toBe(true);
    expect(getProviderConfig('dola-sd2', { ...env, WORKSPACE_ENABLE_LIVE_PROVIDERS: 'false' }).apiKey).toBeUndefined();
    expect(getProviderConfig('dola-sd2', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SEEDREAM_API_KEY: 'apiaw-key' }).apiKey).toBeUndefined();
    expect(getProviderConfig('dola-sd2', { ...env, DOLA_SD2_BASE_URL: 'https://mj.yuansucang.cn/open-api/v1/' }).baseUrl).toBe('https://mj.yuansucang.cn/open-api/v1');
    expect(getProviderConfig('dola-sd2', { ...env, DOLA_SD2_BASE_URL: 'https://evil.example/open-api/v1' }).baseUrl).toBe('https://mj.yuansucang.cn/open-api/v1');
    expect(validateProviderUrl('dola-sd2', 'https://mj.yuansucang.cn/open-api/v1/generations')).toBe(true);
    expect(validateProviderUrl('dola-sd2', 'https://mj.yuansucang.cn.evil.example/open-api/v1/generations')).toBe(false);
  });

  it('exposes catalog without requiring secrets', () => {
    expect(getProviderCatalog().map((provider) => provider.id)).toEqual(expect.arrayContaining(['grok-video', 'yuanai-grok-video', 'mgrouter-grok-image', 'mgrouter-grok-video', 'wan3-video', 'wan-3-nsfw', 'seedream', 'apiaw-seedance-video', 'minimax-h3', 'pro666-video', 'yuanai-gemini-prompt', 'yuanai-image', 'aicloud-gpt-image', 'pomoai-gemini-image', 'pomoai-gpt-prompt', 'oairegbox-gpt-prompt', 'secure-skill-gpt-prompt', 'gpt-2999-prompt', 'oairegbox-omni']));
    expect(isLiveProviderEnabled()).toBe(false);
    expect(isLiveProvidersAllowed()).toBe(false);
    expect(isProviderLiveEnabled('grok-video')).toBe(false);
    expect(isProviderLiveEnabled('minimax-h3')).toBe(false);
    expect(isProviderLiveEnabled('yuanai-grok-video', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_GROK_VIDEO_API_KEY: 'test-key' })).toBe(true);
    expect(isProviderLiveEnabled('wan-3-nsfw', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', WAN_3_NSFW_API_KEY: 'test-key' })).toBe(true);
    expect(isProviderLiveEnabled('apiaw-seedance-video', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SEEDREAM_API_KEY: 'test-key' })).toBe(true);
    expect(isProviderLiveEnabled('seedream', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SEEDREAM_API_KEY: 'test-key' })).toBe(true);
    expect(isProviderLiveEnabled('pro666-video')).toBe(false);
    expect(isProviderLiveEnabled('aicloud-gpt-image', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', AICLOUD_API_KEY: 'test-key' })).toBe(true);
    expect(isProviderLiveEnabled('pomoai-gpt-prompt', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', POMOAI_GPT_PROMPT_API_KEY: 'test-key' })).toBe(true);
    expect(isProviderLiveEnabled('oairegbox-gpt-prompt', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_GPT_PROMPT_API_KEY: 'test-key' })).toBe(true);
    expect(isProviderLiveEnabled('secure-skill-gpt-prompt', { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SECURE_SKILL_GPT_API_KEY: 'test-key' })).toBe(true);
  });

  it('allows only exact provider origins', () => {
    expect(validateProviderUrl('grok-video', 'https://snumom.com/v1/videos')).toBe(true);
    expect(validateProviderUrl('grok-video', 'https://evil.example/v1/videos')).toBe(false);
    expect(validateProviderUrl('mgrouter-grok-image', 'https://raw.mgrouter.com/v1/images/generations')).toBe(true);
    expect(validateProviderUrl('wan3-video', 'https://api.manjuai.top/v1/videos/generations')).toBe(true);
    expect(validateProviderUrl('wan3-video', 'http://api.manjuai.top/v1/videos/generations')).toBe(false);
    expect(validateProviderUrl('wan-3-nsfw', 'https://va.808relay.com/v1/videos')).toBe(true);
    expect(validateProviderUrl('apiaw-seedance-video', 'https://newapi.apiaw.com/v1/videos')).toBe(true);
    expect(validateProviderUrl('seedream', 'https://newapi.apiaw.com/v1/images/generations')).toBe(true);
    expect(validateProviderUrl('minimax-h3', 'https://token.secure-skill.com/v1/videos')).toBe(true);
    expect(validateProviderUrl('secure-skill-gpt-prompt', 'https://token.secure-skill.com/v1/responses')).toBe(true);
    expect(validateProviderUrl('minimax-h3', 'https://api.manjuai.top/v1/videos/generations')).toBe(false);
    expect(validateProviderUrl('pro666-video', 'https://api.pro666.top/v1/videos')).toBe(true);
    expect(validateProviderUrl('aicloud-gpt-image', 'https://aiclound.vip/v1/images/generations')).toBe(true);
    expect(validateProviderUrl('aicloud-gpt-image', 'https://evil.example/v1/images/generations')).toBe(false);
  });

  it('returns safe defaults and never exposes keys', () => {
    const config = getProviderConfig('grok-video');
    expect(config.baseUrl).toBe('https://snumom.com/v1');
    expect(config.apiKey).toBeUndefined();
    expect(Object.keys(config)).not.toContain('authorization');
    expect(getProviderConfig('mgrouter-grok-video').model).toBe('grok-imagine-video-1.5');
    expect(getProviderConfig('yuanai-grok-video').model).toBe('grok-imagine-video-1.5-preview');
    expect(getProviderConfig('wan-3-nsfw').model).toBe('wan-3');
    expect(getProviderConfig('apiaw-seedance-video').model).toBe('seedance2.0-mini');
    expect(getProviderConfig('seedream').model).toBe('dola-seedream-5-0-pro-260628');
    expect(getProviderConfig('seedream').supports.resolutions).toEqual(['1086x1448', '1k']);
    expect(getProviderConfig('minimax-h3').baseUrl).toBe('https://token.secure-skill.com');
    expect(getProviderConfig('minimax-h3').model).toBe('minimax-h3');
    expect(getProviderConfig('pro666-video').baseUrl).toBe('https://api.pro666.top');
    expect(getProviderConfig('pro666-video').model).toBe('sd2-933-mini');
    expect(getProviderConfig('aicloud-gpt-image').baseUrl).toBe('https://aiclound.vip');
    expect(getProviderConfig('aicloud-gpt-image').modelOptions).toEqual(['gpt-image-2.5', 'gpt-image-2.5-plus']);
    expect(getProviderConfig('aicloud-gpt-image').modelResolutions?.['gpt-image-2.5-plus']).toEqual(['2k', '4k']);
    expect(getProviderConfig('pomoai-gpt-prompt').baseUrl).toBe('https://www.pomoai.ai/v1');
    expect(getProviderConfig('oairegbox-gpt-prompt').model).toBe('gpt-5.5');
    expect(getProviderConfig('secure-skill-gpt-prompt')).toMatchObject({ model: 'gpt-5.5', baseUrl: 'https://token.secure-skill.com/v1', liveEnv: 'SECURE_SKILL_GPT_API_KEY' });
  });
});
