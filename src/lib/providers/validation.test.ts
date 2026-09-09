import { describe, expect, it } from 'vitest';
import { validateGenerationRequest } from './validation';

describe('provider generation capability validation', () => {
  it('accepts the recovered Wan 3 five-second contract', () => {
    expect(validateGenerationRequest({
      provider: 'wan3-video',
      duration: 5,
      aspectRatio: '9:16',
      resolution: '720P',
      referenceImages: Array.from({ length: 10 }, (_, index) => `https://assets.example/${index}.jpg`),
      referenceAudios: Array.from({ length: 5 }, (_, index) => `https://assets.example/${index}.wav`),
    })).toEqual({
      duration: 5,
      aspectRatio: '9:16',
      resolution: '720P',
    });
  });

  it('rejects unsupported durations and resolutions instead of silently clamping', () => {
    expect(() => validateGenerationRequest({
      provider: 'grok-video', duration: 5, aspectRatio: '9:16', resolution: '720p',
      referenceImages: [], referenceAudios: [],
    })).toThrow('unsupported_duration');
    expect(() => validateGenerationRequest({
      provider: 'mgrouter-grok-image', aspectRatio: '9:16', resolution: '4k',
      referenceImages: [], referenceAudios: [],
    })).toThrow('unsupported_resolution');
  });

  it('accepts YuanAI Image 4K while keeping MGRouter Image at 1K/2K', () => {
    expect(validateGenerationRequest({
      provider: 'yuanai-image', aspectRatio: '1:1', resolution: '4k', referenceImages: [], referenceAudios: [],
    })).toEqual({ aspectRatio: '1:1', resolution: '4k' });
    expect(() => validateGenerationRequest({
      provider: 'mgrouter-grok-image', aspectRatio: '1:1', resolution: '4k', referenceImages: [], referenceAudios: [],
    })).toThrow('unsupported_resolution');
  });

  it('accepts YuanAI 4k image generation while rejecting 4k for MGRouter', () => {
    expect(validateGenerationRequest({
      provider: 'yuanai-image',
      aspectRatio: '1:1',
      resolution: '4k',
      referenceImages: [],
      referenceAudios: [],
    })).toEqual({ aspectRatio: '1:1', resolution: '4k' });

    expect(() => validateGenerationRequest({
      provider: 'mgrouter-grok-image',
      aspectRatio: '1:1',
      resolution: '4k',
      referenceImages: [],
      referenceAudios: [],
    })).toThrow('unsupported_resolution');
  });

  it('accepts arbitrary integer durations for snumom Grok按秒 model while retaining 720p-only limit', () => {
    expect(validateGenerationRequest({
      provider: 'grok-video', model: 'grok-video-1.5', duration: 7,
      aspectRatio: '16:9', resolution: '720p', referenceImages: [], referenceAudios: [],
    })).toEqual({ duration: 7, aspectRatio: '16:9', resolution: '720p' });
    expect(() => validateGenerationRequest({
      provider: 'grok-video', model: 'grok-video-1.5', duration: 7,
      aspectRatio: '16:9', resolution: '480p', referenceImages: [], referenceAudios: [],
    })).toThrow('unsupported_resolution');
    expect(() => validateGenerationRequest({
      provider: 'grok-video', model: 'grok-video-1.5', duration: 5,
      aspectRatio: '16:9', resolution: '720p', referenceImages: [], referenceAudios: [],
    })).toThrow('unsupported_duration');
  });

  it('applies each provider reference limit', () => {
    expect(() => validateGenerationRequest({
      provider: 'mgrouter-grok-video', duration: 10, aspectRatio: '9:16', resolution: '720p',
      referenceImages: [],
      referenceAudios: ['https://assets.example/0.wav', 'https://assets.example/1.wav', 'https://assets.example/2.wav'],
    })).toThrow('too_many_reference_audios');
    expect(() => validateGenerationRequest({
      provider: 'mgrouter-grok-image', aspectRatio: '9:16', resolution: '2k',
      referenceImages: Array.from({ length: 4 }, (_, index) => `https://assets.example/${index}.jpg`),
      referenceAudios: [],
    })).toThrow('too_many_reference_images');
  });

  it('validates snumom sd-mini contract and accepts seconds alias', () => {
    const base = {
      provider: 'grok-video' as const,
      model: 'sd-mini',
      aspectRatio: '16:9',
      referenceImages: [],
      referenceVideos: [],
      referenceAudios: [],
    };
    expect(validateGenerationRequest({ ...base, seconds: 10 })).toEqual({ duration: 10, aspectRatio: '16:9', resolution: '720p' });
    expect(validateGenerationRequest({ ...base, seconds: 10, resolution: '720p' })).toEqual({ duration: 10, aspectRatio: '16:9', resolution: '720p' });
    expect(validateGenerationRequest({ ...base, seconds: 5 })).toEqual({ duration: 5, aspectRatio: '16:9', resolution: '480p' });
    expect(validateGenerationRequest({ ...base, seconds: 15 })).toEqual({ duration: 15, aspectRatio: '16:9', resolution: '480p' });
    expect(validateGenerationRequest({ ...base, seconds: 10, resolution: '480p' })).toEqual({ duration: 10, aspectRatio: '16:9', resolution: '480p' });
    expect(() => validateGenerationRequest({ ...base, seconds: 10, referenceImages: Array.from({ length: 8 }, (_, index) => `https://assets.example/${index}.jpg`) })).toThrow('too_many_reference_images');
    expect(() => validateGenerationRequest({ ...base, seconds: 10, referenceVideos: ['https://assets.example/ref.mp4'] })).toThrow('too_many_reference_videos');
    expect(() => validateGenerationRequest({ ...base, seconds: 10, referenceAudios: ['https://assets.example/ref.wav'] })).toThrow('too_many_reference_audios');
    expect(() => validateGenerationRequest({ ...base })).toThrow('duration_required');
  });

  it('uses sd-mini defaults when duration and ratio/resolution are supplied explicitly', () => {
    expect(validateGenerationRequest({ provider: 'grok-video', model: 'sd-mini', duration: 10 })).toEqual({ duration: 10, aspectRatio: '9:16', resolution: '720p' });
    expect(validateGenerationRequest({ provider: 'grok-video', model: 'sd-mini', duration: 10, aspectRatio: 'auto', resolution: '720p' })).toEqual({ duration: 10, aspectRatio: 'auto', resolution: '720p' });
  });

  it('defaults image requests to portrait and 4K when supported', () => {
    expect(validateGenerationRequest({ provider: 'yuanai-image', referenceImages: [], referenceAudios: [] })).toEqual({ aspectRatio: '9:16', resolution: '4k' });
    expect(validateGenerationRequest({ provider: 'mgrouter-grok-image', referenceImages: [], referenceAudios: [] })).toEqual({ aspectRatio: '9:16', resolution: '2k' });
  });

  it('uses Aicloud model-specific defaults and rejects unsupported tiers', () => {
    expect(validateGenerationRequest({ provider: 'aicloud-gpt-image', model: 'gpt-image-2.5', referenceImages: [], referenceAudios: [] })).toEqual({ aspectRatio: '9:16', resolution: '1k' });
    expect(validateGenerationRequest({ provider: 'aicloud-gpt-image', model: 'gpt-image-2.5-plus', referenceImages: [], referenceAudios: [] })).toEqual({ aspectRatio: '9:16', resolution: '4k' });
    expect(() => validateGenerationRequest({ provider: 'aicloud-gpt-image', model: 'gpt-image-2.5', resolution: '2k', referenceImages: [], referenceAudios: [] })).toThrow('unsupported_resolution');
    expect(() => validateGenerationRequest({ provider: 'aicloud-gpt-image', model: 'gpt-image-unknown', referenceImages: [], referenceAudios: [] })).toThrow('unsupported_model');
  });
});
