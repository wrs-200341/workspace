/**
 * Capability contracts recovered from the historical workspace production desk.
 * This module is intentionally provider-agnostic: the UI and request boundary
 * can use the same limits without enabling live provider calls.
 */

// Keep the complete aspect-ratio contract exposed by snumom's sd-mini model.
// Existing models continue to advertise only the ratios they support via
// their individual capability entries.
export const VIDEO_ASPECT_RATIOS = ['9:16', '16:9', '1:1', '21:9', '4:3', '3:4', '2:3', '3:2', '9:21', 'auto'] as const;
export const VIDEO_RESOLUTIONS = ['480p', '720p', '768p', '1080p', '1440p', '480P', '720P', '2K'] as const;
export type VideoAspectRatio = typeof VIDEO_ASPECT_RATIOS[number];
export type VideoResolution = typeof VIDEO_RESOLUTIONS[number];
export const DEFAULT_VIDEO_ASPECT_RATIO: VideoAspectRatio = '9:16';

export interface VideoDurationCapability {
  min: number;
  max: number;
  values?: readonly number[];
  /** Supplier accepts arbitrary integer durations beyond the UI presets. */
  unbounded?: boolean;
}

export interface ReferenceCapability {
  min: number;
  max: number;
  required: boolean;
}

export interface VideoCapability {
  duration: VideoDurationCapability;
  aspectRatios: readonly VideoAspectRatio[];
  /** Optional model-specific default aspect ratio. */
  defaultAspectRatio?: VideoAspectRatio;
  resolutions: readonly VideoResolution[];
  /** Optional supplier-specific default; otherwise the highest supported value is used. */
  defaultResolution?: VideoResolution;
  /** Optional supplier-specific default duration; otherwise 10s (or the highest option). */
  defaultDuration?: number;
  /** Optional per-duration resolution restrictions (e.g. sd-mini's 720p/10s rule). */
  resolutionByDuration?: Readonly<Record<number, readonly VideoResolution[]>>;
  referenceImages: ReferenceCapability;
  referenceVideos: ReferenceCapability;
  referenceAudios: ReferenceCapability;
}

export interface VideoCapabilityInput {
  duration: number;
  aspectRatio: string;
  resolution: string;
  referenceCount: number;
  referenceVideoCount?: number;
  referenceAudioCount?: number;
}

export class VideoCapabilityError extends Error {
  readonly code = 'VIDEO_CAPABILITY_INVALID';
}

const none: ReferenceCapability = Object.freeze({ min: 0, max: 0, required: false });
const imageRefs = (max: number, min = 0, required = false): ReferenceCapability => Object.freeze({ min, max, required });

const CAPABILITIES: Record<string, VideoCapability> = {
  'dola-sd2:dola-sd2': {
    duration: { min: 4, max: 15, values: Array.from({ length: 12 }, (_, index) => index + 4) },
    aspectRatios: ['9:16'],
    defaultAspectRatio: '9:16',
    resolutions: ['720p'],
    defaultResolution: '720p',
    defaultDuration: 5,
    referenceImages: imageRefs(1, 1, true),
    referenceVideos: none,
    referenceAudios: none,
  },
  // Historical 9999/OAIRegBox contract: one optional image, fixed 10s/720p.
  'oairegbox:omni': {
    duration: { min: 10, max: 10, values: [10] },
    aspectRatios: ['9:16', '16:9'],
    resolutions: ['720p'],
    referenceImages: imageRefs(5),
    referenceVideos: none,
    referenceAudios: none,
  },
  // Canonical workspace supplier id/model pair used by API routes.
  'oairegbox-omni:omni-fast-no-water': {
    duration: { min: 10, max: 10, values: [10] },
    aspectRatios: ['9:16', '16:9'],
    resolutions: ['720p'],
    referenceImages: imageRefs(5),
    referenceVideos: none,
    referenceAudios: none,
  },
  'quality-v4:quality-v4': {
    duration: { min: 5, max: 15, values: [5, 10, 15] },
    aspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
    defaultAspectRatio: '9:16',
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    resolutionByDuration: { 5: ['480p'], 10: ['480p', '720p'], 15: ['480p'] },
    referenceImages: imageRefs(9),
    referenceVideos: imageRefs(3),
    referenceAudios: imageRefs(3),
  },
  'apiaw-seedance-video:seedance2.0-mini': {
    duration: { min: 4, max: 15, values: Array.from({ length: 12 }, (_, index) => index + 4) },
    aspectRatios: ['1:1', '16:9', '9:16'],
    defaultAspectRatio: '9:16',
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    defaultDuration: 10,
    referenceImages: imageRefs(9),
    referenceVideos: imageRefs(3),
    referenceAudios: imageRefs(3),
  },
  'grok-video:grok': {
    // snumom's按次 model contract: 6–15 seconds, 480p/720p only.
    duration: { min: 6, max: 15, values: [6, 8, 10, 12, 15] },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(7),
    referenceVideos: none,
    referenceAudios: none,
  },
  // snumom's按秒 model contract. Unlike the fixed-price Imagine model,
  // duration is any integer >= 6 seconds and the API currently accepts only
  // 720p. Keep a practical upper bound for the workspace UI/request guard;
  // the provider may reject values outside its account limits upstream.
  'grok-video:grok-video-1.5': {
    duration: { min: 6, max: Number.MAX_SAFE_INTEGER, unbounded: true },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(7),
    referenceVideos: none,
    referenceAudios: none,
  },
  'grok-video:grok-video-1.5-preview': {
    duration: { min: 6, max: Number.MAX_SAFE_INTEGER, unbounded: true },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(7),
    referenceVideos: none,
    referenceAudios: none,
  },
  // snumom sd-mini fixed-price model: 5/10/15 seconds; 720p only at 10s,
  // while 5s and 15s are 480p-only.
  'grok-video:sd-mini': {
    duration: { min: 5, max: 15, values: [5, 10, 15] },
    aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', '9:21', 'auto'],
    defaultAspectRatio: '9:16',
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    resolutionByDuration: {
      5: ['480p'],
      10: ['480p', '720p'],
      15: ['480p'],
    },
    referenceImages: imageRefs(7),
    referenceVideos: none,
    referenceAudios: none,
  },
  // MGRouter's Grok endpoint accepts built-in voice ids, not uploaded audio
  // URLs. Keep file-audio disabled until a dedicated voice-id control exists.
  'mgrouter-grok-video:grok': {
    duration: { min: 6, max: 30, values: [6, 8, 10, 12, 15, 20, 30] },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(7),
    referenceVideos: none,
    referenceAudios: none,
  },
  // Canonical MGRouter model id used by the provider catalog/UI.
  'mgrouter-grok-video:grok-video': {
    duration: { min: 6, max: 30, values: [6, 8, 10, 12, 15, 20, 30] },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(7),
    referenceVideos: none,
    referenceAudios: none,
  },
  // YuanAI/Qingfeng Grok Imagine Video 1.5 preview contract.
  'yuanai-grok-video:grok-imagine-video-1.5-preview': {
    duration: { min: 6, max: 20, values: [6, 10, 12, 16, 20] },
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '2:3', '3:2'],
    defaultAspectRatio: '9:16',
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '1080p',
    referenceImages: imageRefs(7),
    referenceVideos: none,
    referenceAudios: none,
  },
  'minimax:minimax-h3': {
    duration: { min: 4, max: 15, values: [4, 6, 8, 10, 12, 15] },
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(5),
    referenceVideos: none,
    referenceAudios: imageRefs(3),
  },
  'pro666-video:sd2-933-mini': {
    duration: { min: 12, max: 12, values: [12] },
    aspectRatios: ['9:16'],
    resolutions: ['720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(1),
    referenceVideos: none,
    referenceAudios: imageRefs(1),
  },
  // Keep legacy R2V records readable while new requests use the secure-skill
  // MiniMax H3 model above.  The secure-skill contract explicitly rejects
  // reference video fields, so this alias intentionally disables them too.
  'minimax-h3:minimax-h3-r2v': {
    duration: { min: 4, max: 15, values: [4, 6, 8, 10, 12, 15] },
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['720p'],
    defaultResolution: '720p',
    referenceImages: imageRefs(5),
    referenceVideos: none,
    referenceAudios: imageRefs(3),
  },
  'minimax-h3:minimax-h3-t2v': {
    duration: { min: 4, max: 15, values: [4, 6, 8, 10, 12, 15] },
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['720p'],
    defaultResolution: '720p',
    referenceImages: none,
    referenceVideos: none,
    referenceAudios: none,
  },
  // MikuAPI MiniMax H3 Max: 5-15s, 480p/768p, wide reference allowance.
  'miku-minimax:minimax-h3-max': {
    duration: { min: 5, max: 15, values: [5, 6, 8, 10, 12, 15] },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['480p', '768p'],
    defaultResolution: '768p',
    defaultDuration: 10,
    referenceImages: imageRefs(12),
    referenceVideos: imageRefs(12),
    referenceAudios: imageRefs(12),
  },
  // ManjuAI Wan 3 R2V accepts image/video/audio multimodal references.
  'wan3-video:wan3.0-r2v': {
    duration: { min: 5, max: 15, values: [5, 8, 10, 15] },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['480P', '720P'],
    defaultResolution: '720P',
    referenceImages: imageRefs(10),
    referenceVideos: imageRefs(5),
    referenceAudios: imageRefs(5),
  },
  // 808relay Wan 3 / wan-3 contract. The provider documents 2-30 second
  // integer outputs and 480p/720p/1080p resolution tiers.
  'wan-3-nsfw:wan-3': {
    duration: { min: 2, max: 30, values: Array.from({ length: 29 }, (_, index) => index + 2) },
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '9:16',
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    defaultDuration: 5,
    referenceImages: imageRefs(10),
    referenceVideos: imageRefs(5),
    referenceAudios: imageRefs(5),
  },
  'wan3-video:wan3.0-prime-t2v': {
    duration: { min: 5, max: 15, values: [5, 8, 10, 15] },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['480P', '720P'],
    defaultResolution: '720P',
    referenceImages: none,
    referenceVideos: none,
    referenceAudios: none,
  },
  'wan3-video:wan3.0-prime-i2v': {
    duration: { min: 5, max: 15, values: [5, 8, 10, 15] },
    aspectRatios: ['9:16', '16:9', '1:1'],
    resolutions: ['480P', '720P'],
    defaultResolution: '720P',
    referenceImages: imageRefs(1, 1, true),
    referenceVideos: none,
    referenceAudios: none,
  },
};

// Model identifiers used by the earlier production desk builds. Keep aliases
// so restored task payloads remain loadable after the workspace rename.
CAPABILITIES['grok-video:grok-imagine-video-1.5'] = CAPABILITIES['grok-video:grok'];
CAPABILITIES['grok-video:grok-imagine-video-1.5（按次）'] = CAPABILITIES['grok-video:grok'];
CAPABILITIES['grok-video:grok-video-1.5（按秒）'] = CAPABILITIES['grok-video:grok-video-1.5'];
CAPABILITIES['grok-video:grok-video-1.5-preview'] = CAPABILITIES['grok-video:grok-video-1.5'];
CAPABILITIES['mgrouter-grok-video:grok-imagine-video-1.5'] = CAPABILITIES['mgrouter-grok-video:grok'];
CAPABILITIES['mgrouter-grok-video:grok-video'] = CAPABILITIES['mgrouter-grok-video:grok'];
CAPABILITIES['manjuai:wan3-prime-r2v'] = CAPABILITIES['wan3-video:wan3.0-r2v'];
CAPABILITIES['wan3-video:wan3-prime-r2v'] = CAPABILITIES['wan3-video:wan3.0-r2v'];
// Prime ids are retired from the selector; keep them resolvable so restored
// historical tasks still load instead of throwing.
CAPABILITIES['wan3-video:wan3.0-prime-r2v'] = CAPABILITIES['wan3-video:wan3.0-r2v'];
CAPABILITIES['minimax-h3:minimax-h3'] = CAPABILITIES['minimax:minimax-h3'];

export const VIDEO_CAPABILITY_CONFIGS: Readonly<Record<string, VideoCapability>> = CAPABILITIES;

export function getVideoCapability(supplierId: string, modelId: string): VideoCapability {
  const capability = CAPABILITIES[`${supplierId}:${modelId}`];
  if (!capability) throw new Error(`Supplier ${supplierId} does not support model ${modelId}`);
  return cloneCapability(capability);
}

export function getVideoDurationOptions(capability: VideoCapability): number[] {
  if (capability.duration.values?.length) return [...capability.duration.values];
  // Keep the form usable for suppliers that accept an open-ended integer
  // duration. The request boundary still validates the user-entered value;
  // these are only convenient presets shown in the select control.
  if (capability.duration.unbounded) return [6, 8, 10, 12, 15, 20, 30, 60];
  const count = capability.duration.max - capability.duration.min + 1;
  return Array.from({ length: Math.max(0, count) }, (_, index) => capability.duration.min + index);
}

export function getDefaultVideoDuration(capability: VideoCapability): number {
  const options = getVideoDurationOptions(capability);
  if (capability.defaultDuration !== undefined && options.includes(capability.defaultDuration)) return capability.defaultDuration;
  return options.includes(10) ? 10 : options.at(-1) ?? capability.duration.min;
}

export function getDefaultVideoAspectRatio(aspectRatios: readonly VideoAspectRatio[], preferred?: VideoAspectRatio): VideoAspectRatio {
  // Production-wide default takes precedence over model-specific historical
  // preferences whenever the selected model supports portrait output.
  if (aspectRatios.includes(DEFAULT_VIDEO_ASPECT_RATIO)) return DEFAULT_VIDEO_ASPECT_RATIO;
  return preferred && aspectRatios.includes(preferred) ? preferred : (aspectRatios[0] ?? DEFAULT_VIDEO_ASPECT_RATIO);
}

export function getDefaultVideoResolution(capability: VideoCapability): VideoResolution {
  return capability.defaultResolution ?? getHighestVideoResolution(capability.resolutions);
}

const RESOLUTION_RANK: Readonly<Record<string, number>> = {
  '480p': 480,
  '480P': 480,
  '720p': 720,
  '720P': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2K': 2048,
};

export function getHighestVideoResolution(resolutions: readonly VideoResolution[]): VideoResolution {
  return [...resolutions].sort((left, right) => (RESOLUTION_RANK[right] ?? 0) - (RESOLUTION_RANK[left] ?? 0))[0] ?? '720p';
}

export function validateVideoCapability(capability: VideoCapability, input: VideoCapabilityInput): void {
  const duration = Number(input.duration);
  if (!Number.isInteger(duration) || duration < capability.duration.min || (!capability.duration.unbounded && duration > capability.duration.max) || (capability.duration.values && !capability.duration.values.includes(duration))) {
    throw new VideoCapabilityError(`Duration ${input.duration} is not supported`);
  }
  if (!capability.aspectRatios.includes(input.aspectRatio as VideoAspectRatio)) throw new VideoCapabilityError(`Aspect ratio ${input.aspectRatio} is not supported`);
  if (!capability.resolutions.includes(input.resolution as VideoResolution)) throw new VideoCapabilityError(`Resolution ${input.resolution} is not supported; use ${capability.resolutions.join(', ')}`);
  const durationResolutions = capability.resolutionByDuration?.[duration];
  if (durationResolutions && !durationResolutions.includes(input.resolution as VideoResolution)) {
    throw new VideoCapabilityError(`Resolution ${input.resolution} is not supported for ${duration}s; use ${durationResolutions.join(', ')}`);
  }
  validateReference('image', capability.referenceImages, input.referenceCount);
  validateReference('video', capability.referenceVideos, input.referenceVideoCount ?? 0);
  validateReference('audio', capability.referenceAudios, input.referenceAudioCount ?? 0);
}

function validateReference(kind: string, capability: ReferenceCapability, count: number): void {
  if (!Number.isInteger(count) || count < capability.min || count > capability.max || (capability.required && count === 0)) {
    if (capability.required && count === 0) throw new VideoCapabilityError(`This model requires one reference ${kind}`);
    const range = capability.min === capability.max ? `exactly ${capability.min}` : `${capability.min}-${capability.max}`;
    throw new VideoCapabilityError(`This model accepts ${range} reference ${kind}s`);
  }
}

function cloneCapability(capability: VideoCapability): VideoCapability {
  return {
    duration: { min: capability.duration.min, max: capability.duration.max, values: capability.duration.values ? [...capability.duration.values] : undefined, unbounded: capability.duration.unbounded },
    aspectRatios: [...capability.aspectRatios],
    defaultAspectRatio: capability.defaultAspectRatio,
    resolutions: [...capability.resolutions],
    defaultResolution: capability.defaultResolution,
    defaultDuration: capability.defaultDuration,
    resolutionByDuration: capability.resolutionByDuration
      ? Object.fromEntries(Object.entries(capability.resolutionByDuration).map(([duration, resolutions]) => [duration, [...resolutions]]))
      : undefined,
    referenceImages: { ...capability.referenceImages },
    referenceVideos: { ...capability.referenceVideos },
    referenceAudios: { ...capability.referenceAudios },
  };
}
