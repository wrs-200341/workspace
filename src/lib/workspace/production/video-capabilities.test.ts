import { describe, expect, it } from 'vitest';
import {
  VIDEO_CAPABILITY_CONFIGS,
  getDefaultVideoAspectRatio,
  getDefaultVideoDuration,
  getDefaultVideoResolution,
  getVideoCapability,
  getVideoDurationOptions,
  validateVideoCapability,
} from './video-capabilities';

describe('recovered video production capabilities', () => {
  it('exposes the historical Grok contract', () => {
    const capability = getVideoCapability('grok-video', 'grok');
    expect(capability.duration).toEqual({ min: 6, max: 15, values: [6, 8, 10, 12, 15] });
    expect(capability.aspectRatios).toEqual(['9:16', '16:9', '1:1']);
    expect(capability.resolutions).toEqual(['480p', '720p']);
    expect(capability.referenceImages).toEqual({ min: 0, max: 7, required: false });
    expect(getDefaultVideoDuration(capability)).toBe(10);
  });

  it('accepts the exact snumom按次 model identifier', () => {
    const capability = getVideoCapability('grok-video', 'grok-imagine-video-1.5（按次）');
    expect(capability.duration.max).toBe(15);
    expect(capability.resolutions).toEqual(['480p', '720p']);
  });

  it('exposes sd-mini fixed-price duration, ratio, resolution and reference limits', () => {
    const capability = getVideoCapability('grok-video', 'sd-mini');
    expect(capability.duration).toEqual({ min: 5, max: 15, values: [5, 10, 15] });
    expect(capability.aspectRatios).toEqual(['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', '9:21', 'auto']);
    expect(capability.resolutions).toEqual(['480p', '720p']);
    expect(capability.resolutionByDuration).toEqual({ 5: ['480p'], 10: ['480p', '720p'], 15: ['480p'] });
    expect(capability.referenceImages).toEqual({ min: 0, max: 7, required: false });
    expect(capability.referenceVideos).toEqual({ min: 0, max: 0, required: false });
    expect(capability.referenceAudios).toEqual({ min: 0, max: 0, required: false });
    expect(getDefaultVideoDuration(capability)).toBe(10);
    expect(getDefaultVideoResolution(capability)).toBe('720p');
  });

  it('enforces sd-mini duration-specific resolution rules', () => {
    const capability = getVideoCapability('grok-video', 'sd-mini');
    expect(() => validateVideoCapability(capability, { duration: 5, aspectRatio: '16:9', resolution: '720p', referenceCount: 0 })).toThrow('not supported for 5s');
    expect(() => validateVideoCapability(capability, { duration: 15, aspectRatio: '16:9', resolution: '720p', referenceCount: 0 })).toThrow('not supported for 15s');
    expect(() => validateVideoCapability(capability, { duration: 10, aspectRatio: '16:9', resolution: '720p', referenceCount: 8 })).toThrow('reference image');
    expect(() => validateVideoCapability(capability, { duration: 10, aspectRatio: '16:9', resolution: '720p', referenceCount: 0, referenceVideoCount: 1 })).toThrow('reference video');
    expect(() => validateVideoCapability(capability, { duration: 10, aspectRatio: '16:9', resolution: '720p', referenceCount: 0, referenceAudioCount: 1 })).toThrow('reference audio');
  });

  it('keeps MGRouter file-audio and Wan multimodal limits separate', () => {
    expect(getVideoCapability('mgrouter-grok-video', 'grok').referenceAudios).toEqual({ min: 0, max: 0, required: false });
    expect(getVideoCapability('wan3-video', 'wan3.0-prime-r2v').referenceImages.max).toBe(10);
    expect(getVideoCapability('wan3-video', 'wan3.0-prime-r2v').referenceVideos).toEqual({ min: 0, max: 5, required: false });
    expect(getVideoCapability('wan3-video', 'wan3.0-prime-r2v').referenceAudios).toEqual({ min: 0, max: 5, required: false });
  });

  it('uses secure-skill MiniMax H3 limits and rejects reference video', () => {
    const minimax = getVideoCapability('minimax-h3', 'minimax-h3');
    expect(getVideoDurationOptions(minimax)).toEqual([4, 6, 8, 10, 12, 15]);
    expect(minimax.resolutions).toEqual(['720p']);
    expect(minimax.referenceImages.max).toBe(5);
    expect(minimax.referenceVideos.max).toBe(0);
    expect(minimax.referenceAudios.max).toBe(3);
  });

  it('exposes only the reference media kinds supported by each video model', () => {
    const grok = getVideoCapability('grok-video', 'grok-imagine-video-1.5（按次）');
    expect(grok.referenceVideos.max).toBe(0);
    expect(grok.referenceAudios.max).toBe(0);

    const mgrouter = getVideoCapability('mgrouter-grok-video', 'grok');
    expect(mgrouter.referenceVideos.max).toBe(0);
    expect(mgrouter.referenceAudios.max).toBe(0);
    expect(getVideoCapability('mgrouter-grok-video', 'grok-video').referenceAudios.max).toBe(0);

    const wan = getVideoCapability('wan3-video', 'wan3.0-prime-r2v');
    expect(wan.referenceVideos.max).toBeGreaterThan(0);
    expect(wan.referenceAudios.max).toBeGreaterThan(0);
  });

  it('derives deterministic defaults from capability rather than hard-coded UI values', () => {
    const capability = getVideoCapability('wan3-video', 'wan3.0-prime-r2v');
    expect(getVideoDurationOptions(capability)).toEqual([5, 8, 10, 15]);
    expect(getDefaultVideoDuration(capability)).toBe(10);
    expect(getDefaultVideoAspectRatio(capability.aspectRatios)).toBe('9:16');
    expect(getDefaultVideoResolution(capability)).toBe('720P');
  });

  it('rejects values outside a supplier/model capability', () => {
    const capability = VIDEO_CAPABILITY_CONFIGS['mgrouter-grok-video:grok'];
    expect(() => validateVideoCapability(capability, {
      duration: 10,
      aspectRatio: '9:16',
      resolution: '720p',
      referenceCount: 8,
      referenceVideoCount: 0,
      referenceAudioCount: 0,
    })).toThrow('reference image');

    expect(() => validateVideoCapability(capability, {
      duration: 10,
      aspectRatio: '9:16',
      resolution: '720p',
      referenceCount: 0,
      referenceVideoCount: 0,
      referenceAudioCount: 3,
    })).toThrow('reference audio');
  });

  it('fails closed when a supplier/model pair is unknown', () => {
    expect(() => getVideoCapability('missing', 'model')).toThrow('does not support');
  });
});
