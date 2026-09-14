export type ProviderId = 'grok-video' | 'yuanai-grok-video' | 'mgrouter-grok-image' | 'mgrouter-grok-video' | 'wan3-video' | 'wan-3-nsfw' | 'seedream' | 'minimax-h3' | 'miku-minimax' | 'pro666-video' | 'quality-v4' | 'yuanai-gemini-prompt' | 'yuanai-image' | 'aicloud-gpt-image' | 'pomoai-gemini-image' | 'pomoai-gpt-prompt' | 'oairegbox-gpt-prompt' | 'gpt-2999-prompt' | 'oairegbox-omni' | 'origin-gpt-image' | 'origin-grok-image' | 'origin-nano-image' | 'junze-gpt-image' | 'junze-gemini-image' | 'bigsnake-prompt';

export type ProviderCatalogEntry = {
  id: ProviderId;
  name: string;
  kind: 'image' | 'video' | 'prompt';
  model: string;
  baseUrl: string;
  liveEnv: string;
  /** Optional model choices exposed by a single supplier. */
  modelOptions?: readonly string[];
  /** Conversation models exposed by a prompt supplier. */
  promptModelOptions?: readonly string[];
  /** Ordered model fallbacks used when the supplier returns an error. */
  promptFallbackModels?: readonly string[];
  /** Optional per-model resolution choices, keyed by wire model id. */
  modelResolutions?: Readonly<Record<string, readonly string[]>>;
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

/** Model ids returned by PomoAI's /v1/models endpoint (image-only entries are
 * intentionally excluded). Keeping this list in the provider catalog makes
 * the selector and server-side validation use the same source of truth. */
export const POMOAI_CHAT_MODELS = [
  'gpt-5.5', 'gpt-5.5-openai-compact', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-terra-openai-compact', 'gpt-6-astra',
  'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  'claude-haiku-4-5-20251001-thinking', 'claude-haiku-4-5-thinking', 'claude-opus-4-5', 'claude-opus-4-5-20251101',
  'claude-opus-4-5-20251101-thinking', 'claude-opus-4-5-thinking', 'claude-opus-4-6-thinking', 'claude-opus-4-7-thinking',
  'claude-opus-4-8-thinking', 'claude-opus-5', 'claude-opus-5-thinking', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5-20250929-thinking', 'claude-sonnet-4-5-thinking', 'claude-sonnet-4-6-thinking', 'claude-sonnet-5',
  'claude-sonnet-5-thinking', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite-preview', 'gemini-2.5-flash-nothinking',
  'gemini-2.5-pro', 'gemini-2.5-pro-preview', 'gemini-3-flash', 'gemini-3-flash-c', 'gemini-3-flash-preview',
  'gemini-3-flash-preview-nothinking', 'gemini-3-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview',
  'gemini-3.1-pro', 'gemini-3.1-pro-low', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-low', 'gemini-3.1-pro-preview-thinking',
  'gemini-3.1-pro-preview-thinking-128', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.6-flash-tiered',
  'gemini-3.7-flash', 'gemini-3.8-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro', 'deepseek-v4-pro-0813', 'kimi-k2.7-code', 'kimi-k3', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash',
  'qwen3.6-flash', 'qwen3.6-plus', 'qwen3.7-flash', 'qwen3.7-max', 'qwen3.7-plus', 'grok-4.5', 'grok-4.6', 'grok-4.20-reasoning',
] as const;

/** Keep automatic failover practical while still exposing every PomoAI model
 * above for explicit selection. The first two fallbacks are the requested
 * GPT-5.5 -> Gemini 3.8 Flash path. */
export const POMOAI_PROMPT_FALLBACK_MODELS = [
  'gpt-5.5', 'gemini-3.8-flash', 'gpt-5.6-sol', 'gpt-5.6-terra', 'claude-opus-4-8',
  'claude-sonnet-4-6', 'gemini-3.7-flash', 'deepseek-v4-pro', 'kimi-k3', 'glm-5.3', 'qwen3.7-max',
] as const;

const CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'quality-v4', name: 'Quality V4 / crack.cc.cd', kind: 'video', model: 'quality-v4', baseUrl: 'https://video2.crack.cc.cd', liveEnv: 'QUALITY_V4_API_KEY', supports: { referenceImages: 9, referenceVideos: 3, referenceAudios: 3, durations: [5, 10, 15], ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['480p', '720p'] } },
  { id: 'grok-video', name: 'Grok / snumom', kind: 'video', model: 'grok-imagine-video-1.5（按次）', baseUrl: 'https://snumom.com/v1', liveEnv: 'GROK_VIDEO_API_KEY', supports: { referenceImages: 7, referenceVideos: 0, referenceAudios: 0, durations: [6, 8, 10, 12, 15], ratios: ['9:16', '16:9', '1:1'], resolutions: ['480p', '720p'] } },
  { id: 'yuanai-grok-video', name: 'Grok / YuanAI', kind: 'video', model: 'grok-imagine-video-1.5-preview', baseUrl: 'https://yuanai.uk', liveEnv: 'YUANAI_GROK_VIDEO_API_KEY', supports: { referenceImages: 7, referenceVideos: 0, referenceAudios: 0, durations: [6, 10, 12, 16, 20], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '2:3', '3:2'], resolutions: ['480p', '720p', '1080p'] } },
  { id: 'mgrouter-grok-image', name: 'Grok Image / MGRouter', kind: 'image', model: 'grok-imagine-image-quality', baseUrl: 'https://raw.mgrouter.com/v1', liveEnv: 'MGROUTER_API_KEY', supports: { referenceImages: 3, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '2k'] } },
  // MGRouter exposes Grok Imagine Video 1.5 under the same model id returned
  // by its /v1/models catalog. Keep the supplier independent from snumom;
  // only the transport contract is shared conceptually.
  // The MGRouter Grok endpoint accepts built-in voice identifiers (for
  // example `eve`/`leo`) rather than uploaded audio URLs. Until the workspace
  // exposes a voice-id selector, advertise no file-audio capability so an
  // uploaded asset cannot be sent in a shape the upstream rejects with 400.
  { id: 'mgrouter-grok-video', name: 'Grok Video / MGRouter', kind: 'video', model: 'grok-imagine-video-1.5', baseUrl: 'https://raw.mgrouter.com/v1', liveEnv: 'MGROUTER_API_KEY', supports: { referenceImages: 7, referenceVideos: 0, referenceAudios: 0, durations: [6, 8, 10, 12, 15, 20, 30], ratios: ['9:16', '16:9', '1:1'], resolutions: ['480p', '720p'] } },
  // MikuAPI exposes the same OpenAI-compatible async video contract as
  // secure-skill's MiniMax H3, on a different gateway and key.
  { id: 'miku-minimax', name: 'MiniMax H3 Max / MikuAPI', kind: 'video', model: process.env.MIKU_VIDEO_MODEL || 'minimax-h3-max', baseUrl: 'https://mikuapi.org', liveEnv: 'MIKU_API_KEY', supports: { referenceImages: 12, referenceVideos: 12, referenceAudios: 12, durations: [5, 6, 8, 10, 12, 15], ratios: ['9:16', '16:9', '1:1'], resolutions: ['480p', '768p'] } },
  { id: 'wan3-video', name: 'Wan 3 / ManjuAI', kind: 'video', model: 'wan3.0-r2v', baseUrl: 'https://api.manjuai.top', liveEnv: 'WAN_API_KEY', supports: { referenceImages: 10, referenceVideos: 5, referenceAudios: 5, durations: [5, 8, 10, 15], ratios: ['9:16', '16:9', '1:1'], resolutions: ['480P', '720P'] } },
  // 808relay exposes Wan 3 under the wire model `wan-3`. Keep it separate
  // from the historical ManjuAI integration so credentials and model ids do
  // not cross-contaminate each other.
  { id: 'wan-3-nsfw', name: 'Wan 3 NSFW / 808relay', kind: 'video', model: 'wan-3', baseUrl: 'https://va.808relay.com', liveEnv: 'WAN_3_NSFW_API_KEY', supports: { referenceImages: 10, referenceVideos: 5, referenceAudios: 5, durations: Array.from({ length: 29 }, (_, index) => index + 2), ratios: ['16:9', '9:16'], resolutions: ['480p', '720p', '1080p'] } },
  // Seedream 5 is exposed by apiaw through the OpenAI-compatible synchronous
  // image endpoint. It returns `data[].b64_json` directly, so the task is
  // cached locally in the same request instead of being polled as a video.
  // Keep the measured 1086x1448 canvas as an explicit option alongside 1K.
  { id: 'seedream', name: 'Seedream 5 / apiaw', kind: 'image', model: 'dola-seedream-5-0-pro-260628', baseUrl: 'https://newapi.apiaw.com', liveEnv: 'SEEDREAM_API_KEY', supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1', '3:4'], resolutions: ['1086x1448', '1k'] } },
  { id: 'yuanai-gemini-prompt', name: 'YuanAI Gemini', kind: 'prompt', model: process.env.GEMINI_PROMPT_MODEL || 'gemini-2.5-flash', baseUrl: 'https://yuanai.uk', liveEnv: 'GEMINI_PROMPT_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  { id: 'yuanai-image', name: 'YuanAI Image', kind: 'image', model: process.env.YUANAI_IMAGE_MODEL || 'gpt-image-2', baseUrl: 'https://yuanai.uk', liveEnv: 'YUANAI_API_KEY', supports: { referenceImages: 4, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '2k', '4k'] } },
  { id: 'aicloud-gpt-image', name: 'aicloud（大梦）', kind: 'image', model: 'gpt-image-2.5', baseUrl: 'https://aiclound.vip', liveEnv: 'AICLOUD_API_KEY', modelOptions: ['gpt-image-2.5', 'gpt-image-2.5-plus'], modelResolutions: { 'gpt-image-2.5': ['1k'], 'gpt-image-2.5-plus': ['2k', '4k'] }, supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '2k', '4k'] } },
  { id: 'pomoai-gemini-image', name: 'PomoAI Gemini Image', kind: 'image', model: process.env.POMOAI_MODEL || 'gemini-3.1-flash-image', baseUrl: 'https://www.pomoai.ai', liveEnv: 'POMOAI_API_KEY', supports: { referenceImages: 3, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  { id: 'pomoai-gpt-prompt', name: 'GPT / PomoAI', kind: 'prompt', model: process.env.POMOAI_GPT_PROMPT_MODEL || 'gpt-5.5', baseUrl: 'https://www.pomoai.ai/v1', liveEnv: 'POMOAI_GPT_PROMPT_API_KEY', promptModelOptions: POMOAI_CHAT_MODELS, promptFallbackModels: POMOAI_PROMPT_FALLBACK_MODELS, supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  { id: 'oairegbox-gpt-prompt', name: 'GPT-5.5 / OAIRegBox', kind: 'prompt', model: process.env.OAIREGBOX_GPT_PROMPT_MODEL || 'gpt-5.5', baseUrl: 'https://newapi-2.oairegbox.cc/v1', liveEnv: 'OAIREGBOX_GPT_PROMPT_API_KEY', supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  { id: 'gpt-2999-prompt', name: 'GPT / 2999 API (Responses)', kind: 'prompt', model: process.env.GPT_PROMPT_MODEL || 'gpt-5.5', baseUrl: 'https://2999api.com', liveEnv: 'GPT_PROMPT_API_KEY', supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  { id: 'oairegbox-omni', name: 'OAIRegBox Omni', kind: 'video', model: process.env.OAIREGBOX_MODEL || 'omni-fast-no-water', baseUrl: 'https://newapi-2.oairegbox.cc/v1', liveEnv: 'OAIREGBOX_API_KEY', supports: { referenceImages: 5, referenceVideos: 0, referenceAudios: 0, durations: [10], ratios: ['9:16', '16:9'], resolutions: ['720p'] } },
  // OriginGateway's customer document formally specifies the GPT Image 2
  // edit contract: up to 10 input images, with 4K using the same model id
  // and a token that has the 4K capability enabled.
  { id: 'origin-gpt-image', name: 'GPT Image 2 / OriginGateway', kind: 'image', model: 'gpt-image-2', baseUrl: 'https://origingateway.com/v1', liveEnv: 'ORIGIN_GPTIMAGE_API_KEY', supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1', '5:4', '4:5', '4:3', '3:4', '3:2', '2:3', '21:9'], resolutions: ['1k', '4k'] } },
  // OriginGateway exposes the Grok model through the same OpenAI-compatible
  // image-edit route. Its model-specific reference behavior must still be
  // verified with the account's token before production use.
  { id: 'origin-grok-image', name: 'Grok Image 2.0 / OriginGateway', kind: 'image', model: 'grok-imagine-image-2.0', baseUrl: 'https://origingateway.com/v1', liveEnv: 'ORIGIN_GROK_API_KEY', supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  // Nano Banana uses the Gemini-compatible generateContent route when a
  // reference is present so local assets can be sent as inlineData.
  { id: 'origin-nano-image', name: 'Nano Banana Pro / OriginGateway', kind: 'image', model: 'nano-banana-pro', baseUrl: 'https://origingateway.com/v1', liveEnv: 'ORIGIN_NANO_API_KEY', supports: { referenceImages: 3, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  { id: 'junze-gpt-image', name: 'GPT Image 2 / Junze', kind: 'image', model: 'gpt-image-2', baseUrl: 'https://ai.junze.me/v1', liveEnv: 'JUNZE_API_KEY', supports: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k'] } },
  { id: 'junze-gemini-image', name: 'Gemini Image / Junze', kind: 'image', model: process.env.JUNZE_GEMINI_MODEL || 'gemini-3-pro-image-preview', baseUrl: 'https://ai.junze.me', liveEnv: 'JUNZE_API_KEY', supports: { referenceImages: 3, referenceVideos: 0, referenceAudios: 0, ratios: ['9:16', '16:9', '1:1'], resolutions: ['1k', '2k'] } },
  { id: 'bigsnake-prompt', name: 'BigSnake CodexGPT', kind: 'prompt', model: process.env.BIGSNAKE_MODEL || 'gpt-5.5', baseUrl: 'https://api.bigsnake.xyz/v1', liveEnv: 'BIGSNAKE_API_KEY', supports: { referenceImages: 10, referenceVideos: 0, referenceAudios: 0, ratios: [], resolutions: [] } },
  // MiniMax H3 is served by the secure-skill gateway.  It uses the stable
  // OpenAI-compatible async video contract (`/v1/videos`), while Wan 3
  // remains the ManjuAI integration above.  H3 does not accept reference
  // videos; image/audio limits are enforced by the production capability
  // table and request validator.
  { id: 'minimax-h3', name: 'MiniMax H3 / secure-skill', kind: 'video', model: process.env.MINIMAX_MODEL || 'minimax-h3', baseUrl: 'https://token.secure-skill.com', liveEnv: 'MINIMAX_API_KEY', supports: { referenceImages: 5, referenceVideos: 0, referenceAudios: 3, durations: [4, 6, 8, 10, 12, 15], ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], resolutions: ['720p'] } },
  { id: 'pro666-video', name: 'Pro666 / sd2-933-mini', kind: 'video', model: 'sd2-933-mini', baseUrl: 'https://api.pro666.top', liveEnv: 'PRO666_VIDEO_API_KEY', supports: { referenceImages: 1, referenceVideos: 0, referenceAudios: 1, durations: [12], ratios: ['9:16'], resolutions: ['720p'] } },
];

function cloneProvider(provider: ProviderCatalogEntry): ProviderCatalogEntry {
  return {
    ...provider,
    ...(provider.modelOptions ? { modelOptions: [...provider.modelOptions] } : {}),
    ...(provider.promptModelOptions ? { promptModelOptions: [...provider.promptModelOptions] } : {}),
    ...(provider.promptFallbackModels ? { promptFallbackModels: [...provider.promptFallbackModels] } : {}),
    ...(provider.modelResolutions ? { modelResolutions: Object.fromEntries(Object.entries(provider.modelResolutions).map(([model, resolutions]) => [model, [...resolutions]])) } : {}),
    supports: { ...provider.supports, durations: provider.supports.durations ? [...provider.supports.durations] : undefined, ratios: [...provider.supports.ratios], resolutions: [...provider.supports.resolutions] },
  };
}
export function getProviderCatalog(): ProviderCatalogEntry[] { return CATALOG.map(cloneProvider); }
export function isLiveProvidersAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean { return env.WORKSPACE_ENABLE_LIVE_PROVIDERS === 'true'; }
export function getProviderConfig(id: ProviderId, env: Readonly<Record<string, string | undefined>> = process.env): ProviderCatalogEntry & { apiKey?: string } { const provider = CATALOG.find((candidate) => candidate.id === id); if (!provider) throw new Error('provider_not_found'); const envBase = providerBaseEnv(id, env); const baseUrl = envBase && isExactOrigin(envBase, provider.baseUrl) ? envBase.replace(/\/$/, '') : provider.baseUrl; return { ...cloneProvider(provider), baseUrl, apiKey: isLiveProvidersAllowed(env) ? env[provider.liveEnv] || undefined : undefined }; }
export function isLiveProviderEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean { return isLiveProvidersAllowed(env) && Boolean(env.GROK_VIDEO_API_KEY || env.YUANAI_GROK_VIDEO_API_KEY || env.MGROUTER_API_KEY || env.WAN_API_KEY || env.WAN_3_NSFW_API_KEY || env.SEEDREAM_API_KEY || env.MINIMAX_API_KEY || env.MIKU_API_KEY || env.PRO666_VIDEO_API_KEY || env.QUALITY_V4_API_KEY || env.GEMINI_PROMPT_API_KEY || env.YUANAI_API_KEY || env.AICLOUD_API_KEY || env.POMOAI_API_KEY || env.POMOAI_GPT_PROMPT_API_KEY || env.GPT_PROMPT_API_KEY || env.OAIREGBOX_GPT_PROMPT_API_KEY || env.OAIREGBOX_API_KEY || env.ORIGIN_GPTIMAGE_API_KEY || env.ORIGIN_GROK_API_KEY || env.ORIGIN_NANO_API_KEY || env.JUNZE_API_KEY || env.BIGSNAKE_API_KEY); }
export function isProviderLiveEnabled(id: ProviderId, env: Readonly<Record<string, string | undefined>> = process.env): boolean { const config = getProviderConfig(id, env); return isLiveProvidersAllowed(env) && Boolean(config.apiKey); }
export function validateProviderUrl(id: ProviderId, value: string): boolean { try { const url = new URL(value); if (url.protocol !== 'https:') return false; const provider = CATALOG.find((candidate) => candidate.id === id); if (!provider) return false; const base = new URL(provider.baseUrl); return url.origin === base.origin; } catch { return false; } }
function isExactOrigin(value: string, expected: string): boolean { try { const actual = new URL(value); const base = new URL(expected); return actual.protocol === 'https:' && actual.origin === base.origin; } catch { return false; } }
function providerBaseEnv(id: ProviderId, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (id === 'grok-video') return env.GROK_VIDEO_BASE_URL;
  if (id === 'yuanai-grok-video') return env.YUANAI_GROK_VIDEO_BASE_URL;
  if (id === 'mgrouter-grok-image' || id === 'mgrouter-grok-video') return env.MGROUTER_BASE_URL;
  if (id === 'wan3-video') return env.WAN_BASE_URL || env.WAN_VIDEO_BASE_URL;
  if (id === 'wan-3-nsfw') return env.WAN_3_NSFW_BASE_URL;
  if (id === 'seedream') return env.SEEDREAM_BASE_URL;
  if (id === 'yuanai-image') return env.YUANAI_IMAGE_BASE_URL;
  if (id === 'aicloud-gpt-image') return env.AICLOUD_BASE_URL;
  if (id === 'pomoai-gemini-image') return env.POMOAI_BASE_URL;
  if (id === 'oairegbox-omni') return env.OAIREGBOX_BASE_URL;
  if (id === 'minimax-h3') return env.MINIMAX_BASE_URL;
  if (id === 'miku-minimax') return env.MIKU_BASE_URL;
  if (id === 'pro666-video') return env.PRO666_VIDEO_BASE_URL;
  if (id === 'quality-v4') return env.QUALITY_V4_BASE_URL;
  if (id === 'gpt-2999-prompt') return env.GPT_PROMPT_BASE_URL;
  if (id === 'pomoai-gpt-prompt') return env.POMOAI_GPT_PROMPT_BASE_URL;
  if (id === 'oairegbox-gpt-prompt') return env.OAIREGBOX_GPT_PROMPT_BASE_URL;
  if (id === 'origin-gpt-image' || id === 'origin-grok-image' || id === 'origin-nano-image') return env.ORIGIN_BASE_URL;
  if (id === 'junze-gpt-image' || id === 'junze-gemini-image') return env.JUNZE_BASE_URL;
  if (id === 'bigsnake-prompt') return env.BIGSNAKE_BASE_URL;
  return env.GEMINI_PROMPT_BASE_URL;
}

/**
 * SSRF output-host trust is decided by DNS resolution alone (see
 * videoInventory.ts / imageInventory.ts / image-tasks output route): any host
 * whose lookup resolves entirely inside the LAN's RFC 2544 benchmark range
 * (198.18/19) is treated as a safe provider CDN, since that is the range the
 * LAN's DNS proxy remaps every provider hostname into. Onboarding a new
 * provider therefore never requires a host-allowlist edit here.
 */
