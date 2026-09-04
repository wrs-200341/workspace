export type ProviderId = 'grok-video' | 'mgrouter-grok-image' | 'mgrouter-grok-video' | 'wan3-video' | 'minimax-h3' | 'quality-v4' | 'yuanai-gemini-prompt' | 'yuanai-image' | 'pomoai-gemini-image' | 'gpt-2999-prompt' | 'oairegbox-omni' | 'origin-gpt-image' | 'origin-grok-image' | 'origin-nano-image' | 'junze-gpt-image' | 'junze-gemini-image' | 'bigsnake-prompt';

export type ProviderCatalogEntry = {
  id: ProviderId;
  name: string;
  kind: 'image' | 'video' | 'prompt';
  model: string;
  baseUrl: string;
  liveEnv: string;
  /** Capability limits surfaced to the production desk. */
  supports: {
    referenceImages: number;
    referenceVideos?: number;
    referenceAudios: number;
    durations?: readonly number[];
    ratios: readonly string[];
    resolutions: readonly string[];
  };
};

const CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'quality-v4', name: 'Quality V4 / crack.cc.cd', kind: 'video', model: 'quality-v4', baseUrl: 'https://video2.crack.cc.cd', liveEnv: 'QUALITY_V4_API_KEY', supports: { referenceImages: 9, referenceVideos: 3, referenceAudios: 3, durations: [5, 10, 15], ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['480p', '720p'] } },
  { id: 'grok-video', name: 'Grok / snumom', kind: 'video', model: 'grok-imagine-video-1.5（按次）', baseUrl: 'https://snumom.com/v1', liveEnv: 'GROK_VIDEO_API_KEY', supports: { referenceImages: 7, referenceVideos: 0, referenceAudios: 0, durations: [6, 8, 10, 12, 15], ratios: ['9:16', '16:9', '1:1'], resolutions: ['480p', '720p'] } },
  { id: 'mgrouter-grok-image', name: 'Grok Image / MGRouter', kind: 'image', model: 'grok-imagine-image-quality', baseUrl: 'https://raw.mgrouter.com/v1', liveEnv: 'MGROUTER_API_KEY', supports: { referenceImages: 3, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '2k'] } },
  // MGRouter exposes Grok Imagine Video 1.5 under the same model id returned
  // by its /v1/models catalog. Keep the supplier independent from snumom;
  // only the transport contract is shared conceptually.
  // The MGRouter Grok endpoint accepts built-in voice identifiers (for
  // example `eve`/`leo`) rather than uploaded audio URLs. Until the workspace
  // exposes a voice-id selector, advertise no file-audio capability so an
  // uploaded asset cannot be sent in a shape the upstream rejects with 400.
  { id: 'mgrouter-grok-video', name: 'Grok Video / MGRouter', kind: 'video', model: 'grok-imagine-video-1.5', baseUrl: 'https://raw.mgrouter.com/v1', liveEnv: 'MGROUTER_API_KEY', supports: { referenceImages: 7, referenceVideos: 0, referenceAudios: 0, durations: [6, 8, 10, 12, 15, 20, 30], ratios: ['9:16', '16:9', '1:1'], resolutions: ['480p', '720p'] } },
  { id: 'wan3-video', name: 'Wan 3 / ManjuAI', kind: 'video', model: 'wan3.0-prime-r2v', baseUrl: 'https://api.manjuai.top', liveEnv: 'WAN_API_KEY', supports: { referenceImages: 10, referenceVideos: 5, referenceAudios: 5, durations: [5, 8, 10, 15], ratios: ['9:16', '16:9', '1:1'], resolutions: ['480P', '720P'] } },
  { id: 'yuanai-gemini-prompt', name: 'YuanAI Gemini', kind: 'prompt', model: process.env.GEMINI_PROMPT_MODEL || 'gemini-2.5-flash', baseUrl: 'https://yuanai.uk', liveEnv: 'GEMINI_PROMPT_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  { id: 'yuanai-image', name: 'YuanAI Image', kind: 'image', model: process.env.YUANAI_IMAGE_MODEL || 'gpt-image-2', baseUrl: 'https://yuanai.uk', liveEnv: 'YUANAI_API_KEY', supports: { referenceImages: 4, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '2k', '4k'] } },
  { id: 'pomoai-gemini-image', name: 'PomoAI Gemini Image', kind: 'image', model: process.env.POMOAI_MODEL || 'gemini-3.1-flash-image', baseUrl: 'https://www.pomoai.ai', liveEnv: 'POMOAI_API_KEY', supports: { referenceImages: 3, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  { id: 'gpt-2999-prompt', name: 'GPT / 2999 API (Responses)', kind: 'prompt', model: process.env.GPT_PROMPT_MODEL || 'gpt-5.5', baseUrl: 'https://2999api.com', liveEnv: 'GPT_PROMPT_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  { id: 'oairegbox-omni', name: 'OAIRegBox Omni', kind: 'video', model: process.env.OAIREGBOX_MODEL || 'omni-fast-no-water', baseUrl: 'https://newapi-2.oairegbox.cc/v1', liveEnv: 'OAIREGBOX_API_KEY', supports: { referenceImages: 5, referenceVideos: 0, referenceAudios: 0, durations: [10], ratios: ['9:16', '16:9'], resolutions: ['720p'] } },
  { id: 'origin-gpt-image', name: 'GPT Image 2 / OriginGateway', kind: 'image', model: 'gpt-image-2', baseUrl: 'https://origingateway.com/v1', liveEnv: 'ORIGIN_GPTIMAGE_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '4k'] } },
  { id: 'origin-grok-image', name: 'Grok Image 2.0 / OriginGateway', kind: 'image', model: 'grok-imagine-image-2.0', baseUrl: 'https://origingateway.com/v1', liveEnv: 'ORIGIN_GROK_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  { id: 'origin-nano-image', name: 'Nano Banana Pro / OriginGateway', kind: 'image', model: 'nano-banana-pro', baseUrl: 'https://origingateway.com/v1', liveEnv: 'ORIGIN_NANO_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  { id: 'junze-gpt-image', name: 'GPT Image 2 / Junze', kind: 'image', model: 'gpt-image-2', baseUrl: 'https://ai.junze.me/v1', liveEnv: 'JUNZE_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  { id: 'junze-gemini-image', name: 'Gemini Image / Junze', kind: 'image', model: process.env.JUNZE_GEMINI_MODEL || 'gemini-3-pro-image-preview', baseUrl: 'https://ai.junze.me', liveEnv: 'JUNZE_API_KEY', supports: { referenceImages: 3, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '2k'] } },
  { id: 'bigsnake-prompt', name: 'BigSnake CodexGPT', kind: 'prompt', model: process.env.BIGSNAKE_MODEL || 'gpt-5.5', baseUrl: 'https://api.bigsnake.xyz/v1', liveEnv: 'BIGSNAKE_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  // MiniMax H3 is served by the secure-skill gateway.  It uses the stable
  // OpenAI-compatible async video contract (`/v1/videos`), while Wan 3
  // remains the ManjuAI integration above.  H3 does not accept reference
  // videos; image/audio limits are enforced by the production capability
  // table and request validator.
  { id: 'minimax-h3', name: 'MiniMax H3 / secure-skill', kind: 'video', model: process.env.MINIMAX_MODEL || 'minimax-h3', baseUrl: 'https://token.secure-skill.com', liveEnv: 'MINIMAX_API_KEY', supports: { referenceImages: 5, referenceVideos: 0, referenceAudios: 3, durations: [4, 6, 8, 10, 12, 15], ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], resolutions: ['720p'] } },
];

export function getProviderCatalog(): ProviderCatalogEntry[] { return CATALOG.map((provider) => ({ ...provider, supports: { ...provider.supports, durations: provider.supports.durations ? [...provider.supports.durations] : undefined, ratios: [...provider.supports.ratios], resolutions: [...provider.supports.resolutions] } })); }
export function isLiveProvidersAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean { return env.WORKSPACE_ENABLE_LIVE_PROVIDERS === 'true'; }
export function getProviderConfig(id: ProviderId, env: Readonly<Record<string, string | undefined>> = process.env): ProviderCatalogEntry & { apiKey?: string } { const provider = CATALOG.find((candidate) => candidate.id === id); if (!provider) throw new Error('provider_not_found'); const envBase = providerBaseEnv(id, env); const baseUrl = envBase && isExactOrigin(envBase, provider.baseUrl) ? envBase.replace(/\/$/, '') : provider.baseUrl; return { ...provider, baseUrl, apiKey: isLiveProvidersAllowed(env) ? env[provider.liveEnv] || undefined : undefined, supports: { ...provider.supports, durations: provider.supports.durations ? [...provider.supports.durations] : undefined, ratios: [...provider.supports.ratios], resolutions: [...provider.supports.resolutions] } }; }
export function isLiveProviderEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean { return isLiveProvidersAllowed(env) && Boolean(env.GROK_VIDEO_API_KEY || env.MGROUTER_API_KEY || env.WAN_API_KEY || env.MINIMAX_API_KEY || env.QUALITY_V4_API_KEY || env.GEMINI_PROMPT_API_KEY || env.YUANAI_API_KEY || env.POMOAI_API_KEY || env.GPT_PROMPT_API_KEY || env.OAIREGBOX_API_KEY || env.ORIGIN_GPTIMAGE_API_KEY || env.ORIGIN_GROK_API_KEY || env.ORIGIN_NANO_API_KEY || env.JUNZE_API_KEY || env.BIGSNAKE_API_KEY); }
export function isProviderLiveEnabled(id: ProviderId, env: Readonly<Record<string, string | undefined>> = process.env): boolean { const config = getProviderConfig(id, env); return isLiveProvidersAllowed(env) && Boolean(config.apiKey); }
export function validateProviderUrl(id: ProviderId, value: string): boolean { try { const url = new URL(value); if (url.protocol !== 'https:') return false; const provider = CATALOG.find((candidate) => candidate.id === id); if (!provider) return false; const base = new URL(provider.baseUrl); return url.origin === base.origin; } catch { return false; } }
function isExactOrigin(value: string, expected: string): boolean { try { const actual = new URL(value); const base = new URL(expected); return actual.protocol === 'https:' && actual.origin === base.origin; } catch { return false; } }
function providerBaseEnv(id: ProviderId, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (id === 'grok-video') return env.GROK_VIDEO_BASE_URL;
  if (id === 'mgrouter-grok-image' || id === 'mgrouter-grok-video') return env.MGROUTER_BASE_URL;
  if (id === 'wan3-video') return env.WAN_BASE_URL || env.WAN_VIDEO_BASE_URL;
  if (id === 'yuanai-image') return env.YUANAI_IMAGE_BASE_URL;
  if (id === 'pomoai-gemini-image') return env.POMOAI_BASE_URL;
  if (id === 'oairegbox-omni') return env.OAIREGBOX_BASE_URL;
  if (id === 'minimax-h3') return env.MINIMAX_BASE_URL;
  if (id === 'quality-v4') return env.QUALITY_V4_BASE_URL;
  if (id === 'gpt-2999-prompt') return env.GPT_PROMPT_BASE_URL;
  if (id === 'origin-gpt-image' || id === 'origin-grok-image' || id === 'origin-nano-image') return env.ORIGIN_BASE_URL;
  if (id === 'junze-gpt-image' || id === 'junze-gemini-image') return env.JUNZE_BASE_URL;
  if (id === 'bigsnake-prompt') return env.BIGSNAKE_BASE_URL;
  return env.GEMINI_PROMPT_BASE_URL;
}

