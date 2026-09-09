import { getProviderConfig, type ProviderId } from './config';
import { getDefaultImageResolution, getDefaultProductionAspectRatio, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';

export type GenerationValidationInput = {
  provider: ProviderId;
  /** Provider model id; used where a supplier exposes model-specific limits. */
  model?: string;
  duration?: number;
  /** Alias accepted by APIs such as snumom sd-mini. */
  seconds?: number;
  aspectRatio?: string;
  resolution?: string;
  referenceImages?: readonly string[];
  referenceVideos?: readonly string[];
  referenceAudios?: readonly string[];
};

export type GenerationValidationResult = {
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
};

function assertHttps(values: readonly string[], field: 'reference_images' | 'reference_audios'): void {
  for (const value of values) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`${field}_must_be_https`); }
    if (parsed.protocol !== 'https:') throw new Error(`${field}_must_be_https`);
  }
}

function assertHttpOrHttps(values: readonly string[], field: 'reference_images' | 'reference_audios'): void {
  for (const value of values) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`${field}_must_be_https`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${field}_must_be_https`);
  }
}

function assertQualityV4References(values: readonly string[], field: 'reference_images' | 'reference_videos' | 'reference_audios'): void {
  for (const value of values) {
    const trimmed = value.trim();
    if (/^data:[^;]+;base64,[A-Za-z0-9+/=]+$/i.test(trimmed) || /^[A-Za-z0-9+/=]{32,}$/.test(trimmed)) continue;
    let parsed: URL;
    try { parsed = new URL(trimmed); } catch { throw new Error(`${field}_must_be_https`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${field}_must_be_https`);
  }
}

function assertHttpsVideos(values: readonly string[]): void {
  for (const value of values) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('reference_videos_must_be_https'); }
    if (parsed.protocol !== 'https:') throw new Error('reference_videos_must_be_https');
  }
}

export function validateGenerationRequest(input: GenerationValidationInput): GenerationValidationResult {
  const config = getProviderConfig(input.provider);
  const model = input.model?.trim() || config.model;
  if (config.modelOptions && !config.modelOptions.includes(model)) throw new Error('unsupported_model');
  const referenceImages = [...(input.referenceImages ?? [])];
  const referenceVideos = [...(input.referenceVideos ?? [])];
  const referenceAudios = [...(input.referenceAudios ?? [])];
  if (referenceImages.length > config.supports.referenceImages) throw new Error('too_many_reference_images');
  if (referenceVideos.length > (config.supports.referenceVideos ?? 0)) throw new Error('too_many_reference_videos');
  if (referenceAudios.length > config.supports.referenceAudios) throw new Error('too_many_reference_audios');
  const isSdMini = input.provider === 'grok-video' && isSdMiniModel(input.model);
  const isQualityV4 = input.provider === 'quality-v4';
  // sd-mini accepts publicly reachable http(s) image URLs. Other providers
  // retain the workspace's HTTPS-only reference policy.
  if (isQualityV4) assertQualityV4References(referenceImages, 'reference_images');
  else if (isSdMini) assertHttpOrHttps(referenceImages, 'reference_images');
  else assertHttps(referenceImages, 'reference_images');
  if (isQualityV4) assertQualityV4References(referenceVideos, 'reference_videos');
  else assertHttpsVideos(referenceVideos);
  if (isQualityV4) assertQualityV4References(referenceAudios, 'reference_audios');
  else assertHttps(referenceAudios, 'reference_audios');

  const result: GenerationValidationResult = {};
  if (config.kind === 'video') {
    const durationInput = input.duration ?? input.seconds;
    if (!Number.isFinite(durationInput) || durationInput === undefined) throw new Error('duration_required');
    const duration = Math.round(durationInput);
    const isSdMini = input.provider === 'grok-video' && isSdMiniModel(input.model);
    // snumom's按秒 Grok model accepts any integer duration >= 6 (the
    // fixed-price Imagine model remains restricted to its documented values).
    const isGrokPerSecond = input.provider === 'grok-video' && isGrokPerSecondModel(input.model);
    if (isSdMini) {
      // sd-mini accepts exactly 5, 10 or 15 seconds.
      if (!Number.isInteger(durationInput) || ![5, 10, 15].includes(duration)) throw new Error('unsupported_duration');
    } else if (isGrokPerSecond) {
      if (duration < 6 || duration > 120) throw new Error('unsupported_duration');
    } else if (!config.supports.durations?.includes(duration)) {
      throw new Error('unsupported_duration');
    }
    result.duration = duration;
  }
  if (config.kind !== 'prompt') {
    const supportedRatios = isSdMini
      ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'auto']
      : config.supports.ratios;
    const aspectRatio = input.aspectRatio ?? getDefaultProductionAspectRatio(supportedRatios);
    if (!supportedRatios.includes(aspectRatio)) throw new Error('unsupported_aspect_ratio');
    result.aspectRatio = aspectRatio;
    const durationForDefault = result.duration ?? input.duration ?? input.seconds;
    const modelResolutions = config.modelResolutions?.[model] ?? config.supports.resolutions;
    const resolution = config.kind === 'image' ? input.resolution?.trim().toLowerCase() ?? getDefaultImageResolution(modelResolutions) : input.resolution?.trim() ?? (isSdMini && durationForDefault !== 10 ? '480p' : getDefaultVideoResolution(config.supports.resolutions));
    const isGrokPerSecond = input.provider === 'grok-video' && isGrokPerSecondModel(input.model);
    if (isSdMini) {
      // 720p is available only for 10-second jobs; 5s and 15s are 480p-only.
      const duration = result.duration ?? input.duration ?? input.seconds ?? 0;
      if (!['480p', '720p'].includes(resolution) || (resolution === '720p' && duration !== 10)) {
        throw new Error('unsupported_resolution');
      }
    } else if (isGrokPerSecond && resolution !== '720p') throw new Error('unsupported_resolution');
    else if (!isGrokPerSecond && !modelResolutions.map((value) => value.trim().toLowerCase()).includes(resolution.toLowerCase())) throw new Error('unsupported_resolution');
    result.resolution = resolution;
  }
  return result;
}

function isGrokPerSecondModel(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  if (normalized === 'grok-video-1.5（按秒）') return true;
  return normalized === 'grok-video-1.5'
    || normalized === 'grok-video-1.5-preview'
    || normalized === 'grok-video-1.5（按秒）';
}

function isSdMiniModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === 'sd-mini';
}
