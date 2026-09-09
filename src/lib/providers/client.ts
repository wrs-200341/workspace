import { buildGrokVideoPayload, buildYuanAIGrokVideoPayload, buildSdMiniVideoPayload, buildQualityV4VideoPayload, buildMGRouterImagePayload, buildMGRouterVideoPayload, buildWanVideoPayload, buildMiniMaxVideoPayload, buildMikuVideoPayload, buildPro666VideoPayload, buildPomoAIImagePayload, buildYuanAIImagePayload, buildYuanAIImageEditFormData, yuanAIImageSize, buildOAIRegboxPayload, buildOAIRegboxMultipartFormData, buildGPTResponsesPayload, buildOpenAIImagePayload, buildOpenAIImageEditPayload, buildOpenAIImageEditFormData, buildAicloudImagePayload, buildAicloudImageEditPayload, buildAicloudImageEditFormData, buildGeminiNativeImagePayload, buildOriginNanoChatPayload, type GPTPromptAttachment, type MultipartReference } from './payloads';
import { getProviderConfig, isLiveProvidersAllowed, isProviderLiveEnabled, POMOAI_PROMPT_FALLBACK_MODELS, type ProviderId } from './config';
import { dedupeVideoOutputUrls } from './videoOutputUrls';

// A 4K image response can legitimately contain several megabytes of Base64
// JSON. Keep a bounded limit, but do not reject normal 4K generations.
const MAX_RESPONSE_BYTES = 80 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
// Image generation endpoints may spend several minutes rendering an image.
// Keep the short timeout for task submission/status calls, but allow image
// providers to complete their synchronous render window.
const IMAGE_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
// GPT-2999 Responses can take longer than the short task/status timeout,
// especially when the gateway performs reasoning before returning text.
const PROMPT_GENERATION_TIMEOUT_MS = 90 * 1000;
// PomoAI can spend longer processing image-grounded Responses requests than
// the other prompt gateways. Keep its timeout independent so a slow PomoAI
// model is not prematurely treated as a failed provider attempt.
const POMOAI_PROMPT_GENERATION_TIMEOUT_MS = 180 * 1000;
// BigSnake's Codex-compatible gateway can spend well over a minute on
// image-grounded prompts (the response includes a full reasoning envelope).
// Keep this timeout separate from GPT-2999 so a slow BigSnake image request is
// not aborted and misreported as a generic provider failure.
const BIGSNAKE_PROMPT_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_VIDEO_CONTENT_BYTES = 200 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 1 * 1024 * 1024;

export function providerEndpoint(id: ProviderId, operation: 'create' | 'status' | 'content', env: Readonly<Record<string, string | undefined>> = process.env): string {
  const base = getProviderConfig(id, env).baseUrl.replace(/\/$/, '');
  if (id === 'grok-video') return operation === 'create' ? `${base}/videos` : `${base}/videos/{id}` + (operation === 'content' ? '/content' : '');
  if (id === 'yuanai-grok-video') {
    const yuanaiBase = /\/v1$/i.test(base) ? base : `${base}/v1`;
    if (operation === 'create') return `${yuanaiBase}/videos`;
    if (operation === 'content') return `${yuanaiBase}/videos/{id}/content`;
    return `${yuanaiBase}/videos/{id}`;
  }
  if (id === 'mgrouter-grok-image') return operation === 'create' ? `${base}/images/generations` : `${base}/images/{id}`;
  if (id === 'mgrouter-grok-video') {
    if (operation === 'create') return `${base}/videos/generations`;
    if (operation === 'content') return `${base}/videos/{id}/content`;
    return `${base}/videos/{id}`;
  }
  if (id === 'quality-v4') return operation === 'create' ? `${base}/v1/videos/generations` : `${base}/v1/tasks/{id}`;
  if (id === 'wan3-video') {
    // Historical deployments used both https://api.manjuai.top and
    // https://api.manjuai.top/v1 as WAN_BASE_URL. Normalize the path so we
    // never emit the invalid /v1/v1/... variant.
    const wanBase = /\/v1$/i.test(base) ? base : `${base}/v1`;
    return operation === 'create' ? `${wanBase}/videos/generations` : `${wanBase}/videos/tasks/{id}`;
  }
  if (id === 'minimax-h3' || id === 'miku-minimax') {
    // MiniMax H3 uses secure-skill's OpenAI-compatible async video contract.
    // MikuAPI serves the same shape (`/v1/videos` + poll + `/content`) from a
    // different gateway. Wan 3 is the separate ManjuAI integration above.
    const minimaxBase = /\/v1$/i.test(base) ? base : `${base}/v1`;
    return operation === 'create' ? `${minimaxBase}/videos` : `${minimaxBase}/videos/{id}` + (operation === 'content' ? '/content' : '');
  }
  if (id === 'pro666-video') {
    const pro666Base = /\/v1$/i.test(base) ? base : base + '/v1';
    return operation === 'create' ? pro666Base + '/videos' : pro666Base + '/videos/{id}';
  }
  if (id === 'yuanai-image') return operation === 'create' ? `${base}/v1/images/generations` : `${base}/v1/images/{id}`;
  if (id === 'aicloud-gpt-image') return operation === 'create' ? `${base}/v1/images/generations` : `${base}/v1/images/{id}`;
  if (id === 'pomoai-gemini-image') return `${base}/v1beta/models/${encodeURIComponent(getProviderConfig(id, env).model)}:generateContent`;
  if (id === 'gpt-2999-prompt') return `${base}/v1/responses`;
  if (id === 'pomoai-gpt-prompt' || id === 'oairegbox-gpt-prompt') return `${base}/responses`;
  if (id === 'oairegbox-omni') return operation === 'create' ? `${base}/videos` : `${base}/videos/{id}` + (operation === 'content' ? '/content' : '');
  if (id === 'origin-gpt-image' || id === 'origin-grok-image' || id === 'junze-gpt-image') return operation === 'create' ? `${base}/images/generations` : `${base}/images/{id}`;
  if (id === 'origin-nano-image') return operation === 'create' ? `${base}/chat/completions` : `${base}/chat/completions`;
  if (id === 'junze-gemini-image') return `${base.replace(/\/v1\/?$/i, '')}/v1beta/models/${encodeURIComponent(getProviderConfig(id, env).model)}:generateContent`;
  if (id === 'bigsnake-prompt') return `${base}/responses`;
  return `${base}/v1beta/models/${encodeURIComponent(env.GEMINI_PROMPT_MODEL || 'gemini-2.5-flash')}:generateContent`;
}

export function validateReferenceUrls(urls: readonly string[]): string[] {
  return urls.map((value) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('reference_url_must_be_https'); }
    if (url.protocol !== 'https:') throw new Error('reference_url_must_be_https');
    return url.toString();
  });
}

/** Validate public HTTP(S) references for providers (such as sd-mini) that
 * explicitly allow either scheme.  The legacy adapters continue to require
 * HTTPS via validateReferenceUrls above. */
export function validateHttpReferenceUrls(urls: readonly string[]): string[] {
  return urls.map((value) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('reference_url_must_be_http'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('reference_url_must_be_http');
    return url.toString();
  });
}

function validateQualityV4References(urls: readonly string[]): string[] {
  return urls.map((value) => {
    const trimmed = value.trim();
    if (/^data:[^;]+;base64,[A-Za-z0-9+/=]+$/i.test(trimmed) || /^[A-Za-z0-9+/=]{32,}$/.test(trimmed)) return trimmed;
    let parsed: URL;
    try { parsed = new URL(trimmed); } catch { throw new Error('qualityv4_reference_invalid'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('qualityv4_reference_invalid');
    return parsed.toString();
  });
}

export function normalizeGeminiResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return '';
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    return Array.isArray(parts) ? parts.flatMap((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []) : [];
  }).join('\n').trim();
}

/**
 * Extract text from an OpenAI Responses API envelope. The API normally
 * exposes a convenient `output_text` field, but some compatible gateways only
 * return the structured `output[].content[]` blocks. For backwards
 * compatibility we also accept a Chat Completions `choices` envelope when a
 * gateway falls back to that shape.
 */
export function normalizeGPTResponsesResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const root = payload as Record<string, unknown>;
  if (typeof root.output_text === 'string' && root.output_text.trim()) return root.output_text.trim();

  const output = Array.isArray(root.output) ? root.output : [];
  const outputText: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const value = (part as Record<string, unknown>).text;
      if (typeof value === 'string' && value.trim()) outputText.push(value.trim());
    }
  }
  if (outputText.length) return outputText.join('\n');

  // Compatibility with OpenAI-compatible providers that still answer using
  // the Chat Completions envelope.
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const message = (first as Record<string, unknown>).message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string' && content.trim()) return content.trim();
      if (Array.isArray(content)) {
        const parts = content.flatMap((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
          const value = (part as Record<string, unknown>).text;
          return typeof value === 'string' && value.trim() ? [value.trim()] : [];
        });
        if (parts.length) return parts.join('\n');
      }
    }
  }
  return '';
}

export type NormalizedProviderStatus = {
  providerTaskId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'unknown';
  progress: number;
  outputUrls: string[];
  outputBase64: string[];
  error?: string;
};

export type ProviderErrorInfo = {
  code: string;
  status?: number;
  statusText?: string;
  body?: unknown;
  rawBody?: string;
  endpoint?: string;
  method?: string;
  receivedAt: string;
};

/** Error carrying the supplier's bounded response for task diagnostics. */
export class ProviderRequestError extends Error {
  readonly info: ProviderErrorInfo;

  constructor(info: ProviderErrorInfo) {
    super(info.code);
    this.name = 'ProviderRequestError';
    this.info = info;
  }
}

export function providerErrorInfo(error: unknown, fallback?: { body?: unknown; endpoint?: string; method?: string }): ProviderErrorInfo {
  if (error instanceof ProviderRequestError) return error.info;
  const code = error instanceof Error && /^[a-z][a-z0-9_]{2,64}$/.test(error.message) ? error.message : 'provider_request_failed';
  return {
    code,
    ...(fallback?.body !== undefined ? { body: fallback.body } : {}),
    ...(fallback?.endpoint ? { endpoint: fallback.endpoint } : {}),
    ...(fallback?.method ? { method: fallback.method } : {}),
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Keep a diagnostic response useful without persisting credentials or an
 * unbounded supplier payload. Error bodies are already limited to 1 MiB at
 * the HTTP boundary; this second guard protects the task store as well.
 */
export function providerResponseSnapshot(error: unknown, fallback?: { body?: unknown; endpoint?: string; method?: string }): Record<string, unknown> {
  const info = providerErrorInfo(error, fallback);
  const redactRaw = (value: string): string => value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|api[-_]?key|apikey|access[_-]?token|token|secret|password|cookie|set[-_]?cookie|session|jwt)\s*[=:]\s*)(["']?)[^&\s,"'}]+/gi, '$1$2[redacted]')
    .replace(/("(?:authorization|api[_-]?key|apikey|access[_-]?token|token|secret|password|cookie|set[-_]?cookie|session|jwt)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2');
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'string') return redactRaw(value);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/authorization|api[_-]?key|token|secret|password|cookie|set[-_]?cookie|session|jwt/i.test(key)) return [key, '[redacted]'];
      return [key, redact(item)];
    }));
  };
  const safeEndpoint = (value: string): string => {
    try {
      const parsed = new URL(value);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return value.replace(/[?#].*$/, '');
    }
  };
  const snapshot: Record<string, unknown> = {
    code: info.code,
    ...(info.status !== undefined ? { status: info.status } : {}),
    ...(info.statusText ? { statusText: info.statusText } : {}),
    ...(info.endpoint ? { endpoint: safeEndpoint(info.endpoint) } : {}),
    ...(info.method ? { method: info.method } : {}),
    ...(info.body !== undefined ? { body: redact(info.body) } : {}),
    ...(info.rawBody ? { rawBody: redactRaw(info.rawBody) } : {}),
    receivedAt: info.receivedAt,
  };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_ERROR_RESPONSE_BYTES) return snapshot;
  return {
    code: info.code,
    ...(info.status !== undefined ? { status: info.status } : {}),
    ...(info.statusText ? { statusText: info.statusText } : {}),
    ...(info.endpoint ? { endpoint: safeEndpoint(info.endpoint) } : {}),
    ...(info.method ? { method: info.method } : {}),
    rawBody: truncateUtf8(redactRaw(info.rawBody ?? serialized), MAX_ERROR_RESPONSE_BYTES),
    truncated: true,
    receivedAt: info.receivedAt,
  };
}

/**
 * Convert the different response envelopes used by the historical providers
 * into the workspace task contract. The parser is deliberately permissive on
 * field names but only exposes HTTPS output URLs and a redacted error string.
 */
export function normalizeProviderResponse(_provider: ProviderId, payload: unknown): NormalizedProviderStatus {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  const providerTaskId = firstString(data, ['id', 'task_id', 'taskId', 'request_id', 'requestId'])
    ?? firstString(root, ['id', 'task_id', 'taskId', 'request_id', 'requestId']);
  const rawStatus = firstString(data, ['status', 'state', 'phase']) ?? firstString(root, ['status', 'state', 'phase']);
  const normalizedStatus = normalizeStatus(rawStatus);
  const rawProgress = firstNumber(data, ['progress', 'progress_percent', 'percentage']) ?? firstNumber(root, ['progress', 'progress_percent', 'percentage']);
  // snumom returns finished Grok videos in top-level `url`, `result_url`, or
  // `video_url` fields. Those URLs may not include a .mp4 suffix (for example
  // signed CDN URLs), so collect these explicit output fields before applying
  // the extension filter used for generic nested provider envelopes.
  const explicitOutputUrls = [
    ...collectExplicitOutputUrls(data, _provider === 'quality-v4'),
    ...collectExplicitOutputUrls(root, _provider === 'quality-v4'),
    ...(_provider === 'pro666-video' ? [...collectNestedOutputUrls(data), ...collectNestedOutputUrls(root)] : []),
  ];
  // MGRouter status responses return a relative content path
  // (`video.url: /v1/videos/<id>/content`) rather than a public absolute URL.
  // Promote only that exact path to the trusted MGRouter origin so callers can
  // persist a deterministic output URL; arbitrary relative paths stay hidden.
  const normalizedExplicit = _provider === 'mgrouter-grok-video'
    ? [
      ...explicitOutputUrls.map(normalizeMGRouterVideoUrl),
      ...collectMGRouterVideoPaths(root).map(normalizeMGRouterVideoUrl),
    ].filter(Boolean)
    : explicitOutputUrls;
  const outputUrls = dedupeVideoOutputUrls(_provider, [...new Set([...normalizedExplicit, ...collectUrls(root)])])
    .filter((url) => _provider === 'quality-v4' ? /^https?:\/\//i.test(url) : /^https:\/\//i.test(url))
    .map((url) => _provider === 'quality-v4' ? normalizeQualityV4Url(url) : url)
    .filter(Boolean);
  const outputBase64 = [...collectBase64(root), ...collectInlineImageData(root)];
  // Image providers commonly return a successful data envelope without a
  // task status (for example Gemini inlineData or OpenAI b64_json). Treat a
  // validated output as completed so the workspace does not leave finished
  // images stuck in the queue.
  const status = normalizedStatus === 'unknown' && (outputUrls.length > 0 || outputBase64.length > 0)
    ? 'completed'
    : normalizedStatus;
  const progress = status === 'completed' ? 100 : clampProgress(rawProgress ?? (status === 'running' ? 1 : 0));
  const hasError = status === 'failed' || Boolean(data?.error || root?.error);
  const errorDetails = extractProviderErrorDetails(data, root);
  const normalizedError = normalizeProviderErrorCode(errorDetails.code, errorDetails.message, _provider);
  return {
    ...(providerTaskId ? { providerTaskId } : {}),
    status,
    progress,
    outputUrls: [...new Set(outputUrls)],
    outputBase64: [...new Set(outputBase64)],
    ...(hasError ? { error: normalizedError } : {}),
  };
}

function normalizeQualityV4Url(value: string): string {
  try {
    const url = new URL(value);
    // Supplier occasionally emits http://video2.crack.cc.cd media links.
    // Upgrade only this exact trusted origin; never rewrite arbitrary hosts.
    if (url.hostname !== 'video2.crack.cc.cd') return '';
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  } catch { return value; }
}

function normalizeMGRouterVideoUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https:\/\/raw\.mgrouter\.com\/v1\/videos\/[A-Za-z0-9._~-]+\/content(?:[?#].*)?$/i.test(trimmed)) return trimmed;
  if (/^\/v1\/videos\/[A-Za-z0-9._~-]+\/content(?:[?#].*)?$/i.test(trimmed)) return `https://raw.mgrouter.com${trimmed}`;
  return '';
}

function collectMGRouterVideoPaths(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string' && /^(?:https:\/\/raw\.mgrouter\.com)?\/v1\/videos\/[A-Za-z0-9._~-]+\/content(?:[?#].*)?$/i.test(value.trim())) output.push(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => collectMGRouterVideoPaths(item, output));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => collectMGRouterVideoPaths(item, output));
  return output;
}

function normalizeProviderErrorCode(code: string | undefined, message?: string, provider?: ProviderId): string {
  const normalized = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  // Pro666 accepts the request envelope but may reject video_urls later when
  // the account's 933 channel has not enabled video-reference capability.
  // Keep that provider-specific error instead of reporting a generic
  // upstream failure after a long poll.
  if (provider === 'pro666-video' && (normalized.includes('video_urls is not enabled') || (normalized.includes('video url') && normalized.includes('not enabled')))) {
    return 'pro666_reference_video_unsupported';
  }
  if (normalized.includes('image_rejected') || normalized.includes('reference_rejected')) return 'provider_reference_rejected';
  if (normalized.includes('content_policy') || normalized.includes('content review') || normalized.includes('content_review')) return 'provider_content_policy';
  if (normalized.includes('invalid_token') || normalized.includes('invalid_api_key') || normalized.includes('unauthorized')) return 'provider_unauthorized';
  if (normalized.includes('model_not_found') || normalized.includes('no available channel')) return 'provider_model_unavailable';
  if (normalized.includes('task_failed') || normalized.includes('upstream') || normalized.includes('fail_to_fetch_task')) return 'provider_upstream_failed';
  if (normalized.includes('invalid_request') || normalized.includes('invalid_json')) return 'provider_invalid_request';
  if (normalized.includes('failed') || normalized.includes('failure') || normalized.includes('失败') || normalized.includes('退还')) return 'provider_upstream_failed';
  return sanitizeProviderError('provider response error');
}

function extractProviderErrorDetails(
  data: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
): { code?: string; message?: string } {
  const candidates: unknown[] = [data?.error, root?.error, data, root];
  let code: string | undefined;
  let message: string | undefined;
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record) {
      code ??= firstString(record, ['error_code', 'errorCode', 'code', 'type']);
      message ??= firstString(record, ['message', 'detail', 'error_message', 'errorMessage']);
    } else if (typeof candidate === 'string' && !message) {
      message = candidate;
    }
  }
  return { code, message };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  return undefined;
}

function firstNumber(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function clampProgress(value: number): number {
  const normalized = value > 1 && value <= 100 ? value : value * 100;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function normalizeStatus(value: string | undefined): NormalizedProviderStatus['status'] {
  const status = value?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!status) return 'unknown';
  if (['queued', 'pending', 'created', 'submitted', 'waiting'].includes(status)) return 'queued';
  if (['running', 'processing', 'in_progress', 'generating'].includes(status)) return 'running';
  if (['completed', 'complete', 'succeeded', 'success', 'done', 'finished'].includes(status)) return 'completed';
  if (['failed', 'failure', 'error'].includes(status)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(status)) return 'cancelled';
  if (['paused', 'pausing'].includes(status)) return 'paused';
  return 'unknown';
}

function collectUrls(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string' && /^https?:\/\//i.test(value) && /\.(mp4|mov|webm|png|jpe?g|gif|avif)(?:$|[?#])/i.test(value)) output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectUrls(item, output));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => collectUrls(item, output));
  return output;
}

function collectExplicitOutputUrls(value: Record<string, unknown> | undefined, allowHttp = false): string[] {
  if (!value) return [];
  const pattern = allowHttp ? /^https?:\/\//i : /^https:\/\//i;
  return ['url', 'result_url', 'video_url', 'download_url']
    .map((key) => value[key])
    .filter((item): item is string => typeof item === 'string' && pattern.test(item));
}

function collectNestedOutputUrls(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNestedOutputUrls(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (['url', 'video_url', 'result_url', 'download_url'].includes(key) && typeof item === 'string' && /^https:\/\//i.test(item)) output.push(item);
    else collectNestedOutputUrls(item, output);
  }
  return output;
}

function collectBase64(value: unknown, output: string[] = []): string[] {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === 'string' && /^(b64_json|base64|data)$/i.test(key) && item.length > 32) output.push(item);
      else collectBase64(item, output);
    }
  } else if (Array.isArray(value)) value.forEach((item) => collectBase64(item, output));
  return output;
}

/** Origin Nano may return Markdown containing a data:image URI. Convert it
 * into the same data URI contract consumed by the local image cache. */
function collectInlineImageData(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    const pattern = /data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n\t ]{32,})/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) output.push(`data:${match[1].toLowerCase()};base64,${match[2].replace(/[\r\n\t ]+/g, '')}`);
  } else if (Array.isArray(value)) value.forEach((item) => collectInlineImageData(item, output));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => collectInlineImageData(item, output));
  return output;
}

export function sanitizeProviderError(message: string): string {
  const normalized = message.trim();
  // Preserve stable machine-readable codes for UI translation, but never
  // persist arbitrary upstream text that may contain URLs or credentials.
  return /^[a-z][a-z0-9_]{2,64}$/.test(normalized) ? normalized : 'provider request failed';
}

/**
 * Convert a supplier HTTP error envelope into a stable, non-sensitive code.
 * We intentionally discard the upstream message because it may contain
 * account identifiers or request metadata, while preserving enough detail for
 * the workspace UI to tell configuration, model availability, and upstream
 * execution failures apart.
 */
async function providerHttpError(response: Response, request?: { endpoint?: string; method?: string }): Promise<Error> {
  let code = `provider_${response.status}`;
  let rawBody = '';
  let body: unknown;
  try {
    rawBody = await readTextLimited(response, MAX_ERROR_RESPONSE_BYTES);
    body = JSON.parse(rawBody) as unknown;
    const payload = asRecord(body) ?? {};
    const nested = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : undefined;
    const upstreamCode = String(nested?.code ?? payload.code ?? '').toLowerCase();
    const upstreamMessage = String(nested?.message ?? payload.message ?? '').toLowerCase();
    if (response.status === 401 || upstreamCode.includes('invalid_token') || upstreamCode.includes('invalid_api_key') || upstreamMessage.includes('invalid token')) code = 'provider_unauthorized';
    else if (upstreamCode.includes('image_rejected') || upstreamCode.includes('reference_rejected')) code = 'provider_reference_rejected';
    else if (upstreamCode.includes('content_policy') || upstreamCode.includes('content_review') || upstreamMessage.includes('content review')) code = 'provider_content_policy';
    else if (upstreamCode.includes('model_not_found') || upstreamMessage.includes('no available channel')) code = 'provider_model_unavailable';
    else if (upstreamCode.includes('fail_to_fetch_task') || upstreamCode.includes('upstream_task_failed') || upstreamMessage.includes('fail to fetch task')) code = 'provider_upstream_failed';
    else if (upstreamCode.includes('invalid_request') || upstreamCode.includes('invalid_json') || upstreamMessage.includes('invalid request') || upstreamMessage.includes('invalid json')) code = 'provider_invalid_request';
  } catch { /* keep the HTTP status code and raw body */ }
  return new ProviderRequestError({
    code,
    status: response.status,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(rawBody ? { rawBody } : {}),
    ...(request?.endpoint ? { endpoint: request.endpoint } : {}),
    ...(request?.method ? { method: request.method } : {}),
    receivedAt: new Date().toISOString(),
  });
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error('provider_response_too_large');
  const text = await readTextLimited(response, MAX_RESPONSE_BYTES);
  try { return JSON.parse(text); } catch {
    throw new ProviderRequestError({ code: 'provider_invalid_json', rawBody: text, receivedAt: new Date().toISOString() });
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = value.slice(0, maxBytes);
  while (result && Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1);
  return result;
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('provider_response_too_large');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value?.byteLength) continue;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('provider_response_too_large');
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join('');
}

async function requestProvider(url: string, apiKey: string, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  return requestProviderWithFetcher(fetch, url, apiKey, body, timeoutMs);
}

async function requestProviderWithFetcher(fetcher: typeof fetch, url: string, apiKey: string, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch (error) {
    if (isProviderTimeoutError(error)) {
      throw new ProviderRequestError({ code: 'provider_408', endpoint: url, method: 'POST', receivedAt: new Date().toISOString() });
    }
    throw error;
  }
  if (!response.ok) throw await providerHttpError(response, { endpoint: url, method: 'POST' });
  return readJsonLimited(response);
}

export async function syncProviderTask(provider: ProviderId, providerTaskId: string, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<NormalizedProviderStatus & { response: unknown }> {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? fetch;
  const config = getProviderConfig(provider, env);
  if (!config.apiKey) throw new Error('provider_not_configured');
  const endpoint = providerEndpoint(provider, 'status', env).replace('{id}', encodeURIComponent(providerTaskId));
  const response = await fetcher(endpoint, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' });
  if (!response.ok) throw await providerHttpError(response, { endpoint, method: 'GET' });
  const payload = await readJsonLimited(response);
  return { ...normalizeProviderResponse(provider, payload), ...(provider === 'yuanai-grok-video' ? { providerTaskId } : {}), response: payload };
}

/**
 * Download a completed video from providers exposing the historical
 * `/videos/{id}/content` endpoint (snumom/Grok, MGRouter, OAIRegBox, and
 * secure-skill MiniMax H3). This keeps the
 * provider credential on the server and applies a strict binary size guard;
 * callers can then persist the bytes under the D-drive workspace data root.
 */
export async function downloadProviderVideoContent(
  provider: ProviderId,
  providerTaskId: string,
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (provider !== 'grok-video' && provider !== 'yuanai-grok-video' && provider !== 'mgrouter-grok-video' && provider !== 'oairegbox-omni' && provider !== 'minimax-h3' && provider !== 'miku-minimax') throw new Error('provider_content_unsupported');
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? fetch;
  const config = getProviderConfig(provider, env);
  if (!config.apiKey) throw new Error('provider_not_configured');
  const normalizedId = providerTaskId.trim();
  if (!normalizedId || normalizedId.length > 256) throw new Error('provider_task_id_invalid');
  const endpoint = providerEndpoint(provider, 'content', env).replace('{id}', encodeURIComponent(normalizedId));
  const response = await fetcher(endpoint, {
    method: 'GET',
    headers: { accept: 'video/mp4, application/octet-stream', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) throw await providerHttpError(response, { endpoint, method: 'GET' });
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_VIDEO_CONTENT_BYTES) throw new Error('provider_response_too_large');
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || 'video/mp4';
  if (!mimeType.startsWith('video/')) throw new Error('provider_video_content_invalid');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.byteLength > MAX_VIDEO_CONTENT_BYTES) throw new Error('provider_video_content_invalid');
    return { bytes, mimeType };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value?.byteLength) continue;
      total += next.value.byteLength;
      if (total > MAX_VIDEO_CONTENT_BYTES) {
        await reader.cancel();
        throw new Error('provider_response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error('provider_video_content_invalid');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, mimeType };
}

export type SubmitVideoInput = { provider: Extract<ProviderId, 'grok-video' | 'yuanai-grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'minimax-h3' | 'miku-minimax' | 'pro666-video' | 'quality-v4' | 'oairegbox-omni'>; model: string; prompt: string; duration: number; aspectRatio: string; resolution: string; referenceImages?: string[]; referenceFiles?: MultipartReference[]; referenceAudios?: string[]; referenceVideos?: string[]; media?: Array<{ type: 'reference_image' | 'reference_video' | 'audio'; url: string }> };

export async function submitVideo(input: SubmitVideoInput, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const isSdMini = input.provider === 'grok-video' && input.model === 'sd-mini';
  const isYuanAIGrok = input.provider === 'yuanai-grok-video';
  const isMiniMax = input.provider === 'minimax-h3';
  const isMiku = input.provider === 'miku-minimax';
  const isPro666 = input.provider === 'pro666-video';
  const config = getProviderConfig(input.provider, env);
  if (input.provider === 'mgrouter-grok-video' && (input.referenceAudios?.length || input.media?.some((item) => item.type === 'audio'))) {
    throw new Error('mgrouter_reference_audio_unsupported');
  }
  if (isSdMini && (input.referenceAudios?.length || input.referenceFiles?.length || input.media?.some((item) => item.type !== 'reference_image'))) {
    throw new Error('sdmini_reference_media_unsupported');
  }
  if (isYuanAIGrok && (input.referenceAudios?.length || input.referenceVideos?.length || input.referenceFiles?.length || input.media?.some((item) => item.type !== 'reference_image'))) {
    throw new Error('yuanai_grok_reference_media_unsupported');
  }
  if (isMiniMax && (input.referenceFiles?.length || input.referenceVideos?.length || input.media?.some((item) => item.type === 'reference_video'))) {
    throw new Error('minimax_reference_media_unsupported');
  }
  if (isPro666 && (input.referenceFiles?.length || input.referenceVideos?.length || input.media?.some((item) => item.type === 'reference_video'))) {
    throw new Error('pro666_reference_video_unsupported');
  }
  if (input.provider === 'oairegbox-omni' && (input.referenceImages ?? []).length > 0 && !(input.referenceFiles?.length)) throw new Error('reference_files_required');
  const sdMediaReferences = isSdMini && (!input.referenceImages || input.referenceImages.length === 0)
    ? (input.media ?? []).filter((item) => item.type === 'reference_image').map((item) => item.url)
    : [];
  const rawReferenceImages = isSdMini && sdMediaReferences.length > 0 ? sdMediaReferences : (input.referenceImages ?? []);
  const references = input.provider === 'quality-v4'
    ? validateQualityV4References(rawReferenceImages)
    : isSdMini ? validateHttpReferenceUrls(rawReferenceImages) : validateReferenceUrls(input.referenceImages ?? []);
  const hasOaiFiles = input.provider === 'oairegbox-omni' && Boolean(input.referenceFiles?.length);
  const body = input.provider === 'quality-v4'
    ? buildQualityV4VideoPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, resolution: input.resolution, size: input.aspectRatio, referenceImages: references, referenceVideos: validateQualityV4References(input.referenceVideos ?? []), referenceAudios: validateQualityV4References(input.referenceAudios ?? []) })
    : input.provider === 'oairegbox-omni'
    ? (hasOaiFiles
      ? buildOAIRegboxMultipartFormData({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, references: input.referenceFiles })
      : buildOAIRegboxPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, references: [] }))
    : input.provider === 'minimax-h3'
    ? buildMiniMaxVideoPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references, referenceAudios: validateReferenceUrls(input.referenceAudios ?? []) })
    : isMiku
    ? buildMikuVideoPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references, referenceVideos: validateReferenceUrls(input.referenceVideos ?? []), referenceAudios: validateReferenceUrls(input.referenceAudios ?? []) })
    : isPro666
    ? buildPro666VideoPayload({ prompt: input.prompt.trim(), images: validateReferenceUrls(input.referenceImages ?? []), audios: validateReferenceUrls(input.referenceAudios ?? []) })
    : isSdMini
    ? buildSdMiniVideoPayload({ model: input.model, prompt: input.prompt.trim(), seconds: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references })
    : isYuanAIGrok
    ? buildYuanAIGrokVideoPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references })
    : input.provider === 'grok-video'
    ? buildGrokVideoPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references })
    : input.provider === 'mgrouter-grok-video'
      ? buildMGRouterVideoPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references, referenceAudios: validateReferenceUrls(input.referenceAudios ?? []) })
      : buildWanVideoPayload({
        model: input.model,
        prompt: input.prompt.trim(),
        duration: input.duration,
        ratio: input.aspectRatio,
        resolution: input.resolution,
        // Support both the canonical `media` array and the historical split
        // referenceImages/referenceAudios fields used by the API route.
        media: (input.media?.length
          ? input.media
          : [
            ...references.map((url) => ({ type: 'reference_image' as const, url })),
            ...validateReferenceUrls(input.referenceAudios ?? []).map((url) => ({ type: 'audio' as const, url })),
          ]).map((item) => ({ ...item, url: validateReferenceUrls([item.url])[0] })),
      });
  if (!config.apiKey) {
    // Mock execution is only allowed while live providers are explicitly
    // disabled. Once live mode is enabled, silently falling back to a mock
    // would make an unconfigured supplier look successful in production.
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider: input.provider, response: { id: `mock_${Date.now()}`, status: 'queued', payload: body } };
  }
  if (body instanceof FormData) {
    const endpoint = providerEndpoint(input.provider, 'create', env);
    const response = await (dependencies.fetch ?? fetch)(endpoint, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, body, signal: AbortSignal.timeout(25_000), cache: 'no-store' });
    if (!response.ok) throw await providerHttpError(response, { endpoint, method: 'POST' });
    return { mode: 'live', provider: input.provider, response: await readJsonLimited(response) };
  }
  return { mode: 'live', provider: input.provider, response: await requestProviderWithFetcher(dependencies.fetch ?? fetch, providerEndpoint(input.provider, 'create', env), config.apiKey, body) };
}

const FALLBACK_PROVIDER_ERRORS = new Set([
  'provider_upstream_failed', 'provider_request_failed', 'provider_408', 'provider_429',
  'provider_500', 'provider_502', 'provider_503', 'provider_504', 'provider_524',
  'provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable',
]);

function grokFallbackProviders(provider: SubmitVideoInput['provider'], model: string, env: Readonly<Record<string, string | undefined>>): SubmitVideoInput['provider'][] {
  if (!['grok-video', 'mgrouter-grok-video', 'yuanai-grok-video'].includes(provider)) return [];
  if (model.trim().toLowerCase() === 'sd-mini') return [];
  const candidates: SubmitVideoInput['provider'][] = ['grok-video', 'mgrouter-grok-video', 'yuanai-grok-video'];
  return candidates.filter((candidate) => candidate !== provider && isProviderLiveEnabled(candidate, env));
}

function grokFallbackModel(provider: SubmitVideoInput['provider']): string {
  if (provider === 'yuanai-grok-video') return 'grok-imagine-video-1.5-preview';
  if (provider === 'mgrouter-grok-video') return 'grok-imagine-video-1.5';
  return getProviderConfig('grok-video').model;
}

function adaptGrokFallbackInput(input: SubmitVideoInput, provider: SubmitVideoInput['provider'], env: Readonly<Record<string, string | undefined>>): Pick<SubmitVideoInput, 'duration' | 'aspectRatio' | 'resolution'> {
  const supports = getProviderConfig(provider, env).supports;
  const durations = supports.durations ? [...supports.durations] : [];
  const duration = durations.length && !durations.includes(input.duration)
    ? durations.reduce((best, value) => Math.abs(value - input.duration) < Math.abs(best - input.duration) ? value : best, durations[0])
    : input.duration;
  const ratios = supports.ratios;
  const aspectRatio = ratios.some((value) => value.toLowerCase() === input.aspectRatio.toLowerCase())
    ? input.aspectRatio
    : (ratios.find((value) => value === '9:16') ?? ratios[0] ?? input.aspectRatio);
  const resolutions = supports.resolutions;
  const exactResolution = resolutions.find((value) => value.toLowerCase() === input.resolution.toLowerCase());
  const resolution = exactResolution ?? (resolutions.length ? resolutions.reduce((best, value) => {
    const numeric = Number.parseInt(value, 10) || 0;
    const bestNumeric = Number.parseInt(best, 10) || 0;
    const requestedNumeric = Number.parseInt(input.resolution, 10) || 0;
    // Prefer the highest available resolution that does not exceed the
    // requested one; if all are larger, use the smallest supported value.
    if (numeric <= requestedNumeric && bestNumeric > requestedNumeric) return value;
    if (numeric <= requestedNumeric && bestNumeric <= requestedNumeric) return numeric > bestNumeric ? value : best;
    return bestNumeric > requestedNumeric && numeric < bestNumeric ? value : best;
  }, resolutions[0]) : input.resolution);
  return { duration, aspectRatio, resolution };
}

function canFallbackFromProviderError(error: unknown): boolean {
  const info = providerErrorInfo(error);
  return FALLBACK_PROVIDER_ERRORS.has(info.code);
}

/**
 * Submit a video and fail over between suppliers of the same Grok model when
 * the upstream is unavailable. Validation and capability errors are returned
 * immediately; only provider/network failures are eligible for failover.
 */
export async function submitVideoWithFallback(
  input: SubmitVideoInput,
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch; skipProviders?: readonly ProviderId[] } = {},
): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; model: string; response: unknown; fallbackFrom?: ProviderId; fallbackProviders?: ProviderId[]; fallbackParameters?: Pick<SubmitVideoInput, 'duration' | 'aspectRatio' | 'resolution'> }> {
  const env = dependencies.env ?? process.env;
  const allCandidates = [input.provider, ...grokFallbackProviders(input.provider, input.model, env)];
  const skipped = new Set(dependencies.skipProviders ?? []);
  const availableCandidates = allCandidates.filter((candidate) => !skipped.has(candidate));
  const candidates = availableCandidates.length ? availableCandidates : [input.provider];
  let lastError: unknown;
  let attemptedFallbacks: ProviderId[] = [];
  for (const provider of candidates) {
    if (provider !== input.provider) attemptedFallbacks = [...attemptedFallbacks, provider];
    const model = provider === input.provider ? input.model : grokFallbackModel(provider);
    const parameters = provider === input.provider ? { duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution } : adaptGrokFallbackInput(input, provider, env);
    try {
      const result = await submitVideo({ ...input, provider, model, ...parameters }, dependencies);
      const normalized = normalizeProviderResponse(provider, result.response);
      if (normalized.status === 'failed') {
        const code = normalized.error ?? 'provider_upstream_failed';
        if (!FALLBACK_PROVIDER_ERRORS.has(code) || provider === candidates.at(-1)) {
          return { ...result, provider, model, ...(attemptedFallbacks.length ? { fallbackFrom: input.provider, fallbackProviders: attemptedFallbacks, fallbackParameters: parameters } : {}) };
        }
        continue;
      }
      return { ...result, provider, model, ...(attemptedFallbacks.length ? { fallbackFrom: input.provider, fallbackProviders: attemptedFallbacks, fallbackParameters: parameters } : {}) };
    } catch (error) {
      lastError = error;
      if (!canFallbackFromProviderError(error) || provider === candidates.at(-1)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('provider_request_failed');
}

export async function generatePomoAIImage(input: { model: string; prompt: string; references?: Array<{ mimeType: string; dataBase64: string }>; aspectRatio?: string; resolution?: string }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  if ((input.references ?? []).length > 3) throw new Error('too_many_reference_images');
  const live = env.WORKSPACE_ENABLE_LIVE_PROVIDERS === 'true' && Boolean(env.POMOAI_API_KEY?.trim());
  const payload = buildPomoAIImagePayload(input);
  if (!live) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider: 'pomoai-gemini-image', response: { id: `mock_pomo_${Date.now()}`, status: 'queued', payload } };
  }
  const base = getProviderConfig('pomoai-gemini-image', env).baseUrl;
  const endpoint = `${base}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const response = await fetcherRequest(dependencies.fetch ?? fetch, endpoint, env.POMOAI_API_KEY!.trim(), payload, false, IMAGE_GENERATION_TIMEOUT_MS);
  return { mode: 'live', provider: 'pomoai-gemini-image', response };
}

export async function generateOpenAICompatibleImage(
  provider: Extract<ProviderId, 'origin-gpt-image' | 'origin-grok-image' | 'junze-gpt-image' | 'aicloud-gpt-image'>,
  input: { model: string; prompt: string; aspectRatio?: string; resolution?: string; referenceImages?: readonly string[]; referenceFiles?: readonly MultipartReference[] },
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const config = getProviderConfig(provider, env);
  const references = validateReferenceUrls(input.referenceImages ?? []);
  const referenceFiles = [...(input.referenceFiles ?? [])];
  if (provider === 'junze-gpt-image' && (references.length > 0 || referenceFiles.length > 0)) throw new Error('reference_images_unsupported');
  // OriginGateway's Grok image edit route is JSON-only. A multipart body is
  // rejected with HTTP 415 (`Unsupported Media Type`), so callers must
  // publish local assets first and pass their HTTPS bridge URLs instead.
  if (provider === 'origin-grok-image' && referenceFiles.length > 0) throw new Error('origin_grok_reference_requires_json');
  if (references.length + referenceFiles.length > config.supports.referenceImages) throw new Error('too_many_reference_images');
  if (provider === 'origin-gpt-image' && references.length > 0 && referenceFiles.length === 0 && input.resolution?.trim().toLowerCase() === '4k') throw new Error('origin_4k_reference_requires_multipart');
  const isAicloud = provider === 'aicloud-gpt-image';
  const genericPayload = isAicloud
    ? buildAicloudImagePayload({ model: input.model, prompt: input.prompt, aspectRatio: input.aspectRatio, resolution: input.resolution })
    : buildOpenAIImagePayload({ model: input.model, prompt: input.prompt, aspectRatio: input.aspectRatio, resolution: input.resolution, quality: provider === 'origin-grok-image' ? 'medium' : 'high', originGateway: provider !== 'junze-gpt-image' });
  const payload = provider === 'junze-gpt-image'
    ? { ...genericPayload, size: input.aspectRatio === '9:16' ? '9:16' : '1024x1024', quality: 'low' }
    : genericPayload;
  const hasReferences = references.length > 0 || referenceFiles.length > 0;
  const editPayload = hasReferences && referenceFiles.length === 0
    ? (isAicloud
      ? buildAicloudImageEditPayload({ model: input.model, prompt: input.prompt, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references })
      : buildOpenAIImageEditPayload({ model: input.model, prompt: input.prompt, aspectRatio: input.aspectRatio, resolution: input.resolution, quality: provider === 'origin-grok-image' ? 'medium' : 'high', referenceImages: references }))
    : payload;
  const editForm = hasReferences && referenceFiles.length > 0
    ? (isAicloud
      ? buildAicloudImageEditFormData({ model: input.model, prompt: input.prompt, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references, referenceFiles })
      : buildOpenAIImageEditFormData({ model: input.model, prompt: input.prompt, aspectRatio: input.aspectRatio, resolution: input.resolution, quality: provider === 'origin-grok-image' ? 'medium' : 'high', referenceImages: references, referenceFiles }))
    : undefined;
  if (!config.apiKey) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider, response: { id: `mock_${provider}_${Date.now()}`, status: 'queued', payload: editForm ?? editPayload } };
  }
  const endpoint = hasReferences
    ? `${config.baseUrl.replace(/\/$/, '')}${isAicloud ? '/v1/images/edits' : '/images/edits'}`
    : providerEndpoint(provider, 'create', env);
  if (editForm) {
    const response = await (dependencies.fetch ?? fetch)(endpoint, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, body: editForm, signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS), cache: 'no-store' });
    if (!response.ok) throw await providerHttpError(response, { endpoint, method: 'POST' });
    return { mode: 'live', provider, response: await readJsonLimited(response) };
  }
  return { mode: 'live', provider, response: await requestProviderWithFetcher(dependencies.fetch ?? fetch, endpoint, config.apiKey, hasReferences ? editPayload : payload, IMAGE_GENERATION_TIMEOUT_MS) };
}

export async function generateGeminiNativeImage(
  provider: Extract<ProviderId, 'origin-nano-image' | 'junze-gemini-image'>,
  input: { model: string; prompt: string; aspectRatio?: string; resolution?: string; references?: Array<{ mimeType: string; dataBase64: string }> },
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const config = getProviderConfig(provider, env);
  const payload = buildGeminiNativeImagePayload({ model: input.model, prompt: input.prompt, aspectRatio: input.aspectRatio, resolution: provider === 'origin-nano-image' ? undefined : input.resolution, references: input.references });
  if (!config.apiKey) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider, response: { id: `mock_${provider}_${Date.now()}`, status: 'queued', payload } };
  }
  const nativeBase = provider === 'origin-nano-image' || provider === 'junze-gemini-image'
    ? config.baseUrl.replace(/\/v1\/?$/i, '')
    : config.baseUrl.replace(/\/$/, '');
  const endpoint = `${nativeBase}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  return { mode: 'live', provider, response: await fetcherRequest(dependencies.fetch ?? fetch, endpoint, config.apiKey, payload, false, IMAGE_GENERATION_TIMEOUT_MS, provider !== 'origin-nano-image') };
}

export async function generateOriginNanoImage(
  input: { model: string; prompt: string; aspectRatio?: string; resolution?: string; references?: Array<{ mimeType: string; dataBase64: string }>; referenceImages?: readonly string[] },
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const provider: ProviderId = 'origin-nano-image';
  const config = getProviderConfig(provider, env);
  if ((input.references ?? []).length > config.supports.referenceImages) throw new Error('too_many_reference_images');
  if ((input.referenceImages ?? []).length > 0) throw new Error('origin_nano_external_reference_unsupported');
  // The OpenAI-compatible chat path has no image content slot. Route any
  // reference-image request through the Gemini-compatible endpoint, where
  // OriginGateway accepts inlineData parts.
  if ((input.references ?? []).length > 0) return generateGeminiNativeImage(provider, input, dependencies);
  // The chat-compatible route is reliable for square output. Portrait output
  // must use Gemini native generateContent to preserve the requested ratio.
  if ((input.aspectRatio ?? '1:1') === '9:16') return generateGeminiNativeImage(provider, input, dependencies);
  const payload = buildOriginNanoChatPayload(input.model, input.prompt);
  if (!config.apiKey) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider, response: { id: `mock_origin_nano_${Date.now()}`, status: 'queued', payload } };
  }
  return { mode: 'live', provider, response: await requestProviderWithFetcher(dependencies.fetch ?? fetch, providerEndpoint(provider, 'create', env), config.apiKey, payload, IMAGE_GENERATION_TIMEOUT_MS) };
}

export async function generateGPTPrompt(input: { model: string; messages: readonly { role: 'user' | 'assistant' | 'system'; content: string }[]; attachments?: readonly GPTPromptAttachment[] }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; text: string; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const payload = buildGPTResponsesPayload(input.model, input.messages, input.attachments ?? []);
  const live = env.WORKSPACE_ENABLE_LIVE_PROVIDERS === 'true' && Boolean(env.GPT_PROMPT_API_KEY?.trim());
  if (!live) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider: 'gpt-2999-prompt', text: '', response: { id: `mock_gpt_${Date.now()}`, status: 'queued', payload } };
  }
  const base = getProviderConfig('gpt-2999-prompt', env).baseUrl;
  const response = await fetcherRequest(dependencies.fetch ?? fetch, `${base}/v1/responses`, env.GPT_PROMPT_API_KEY!.trim(), payload, true, PROMPT_GENERATION_TIMEOUT_MS);
  const text = normalizeGPTResponsesResponse(response);
  return { mode: 'live', provider: 'gpt-2999-prompt', text, response };
}

type ResponsesPromptProvider = Extract<ProviderId, 'pomoai-gpt-prompt' | 'oairegbox-gpt-prompt'>;
export type PromptGenerationResult = { mode: 'live' | 'mock'; provider: ProviderId; model: string; text: string; response: unknown; fallbackFrom?: ProviderId; fallbackProviders?: ProviderId[]; fallbackModels?: string[] };

/** OpenAI Responses-compatible child-prompt provider (PomoAI or OAIRegBox). */
export async function generateResponsesPrompt(
  provider: ResponsesPromptProvider,
  input: { model?: string; prompt: string; attachments?: readonly GPTPromptAttachment[] },
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<PromptGenerationResult> {
  const env = dependencies.env ?? process.env;
  const config = getProviderConfig(provider, env);
  const model = input.model?.trim() || config.model;
  const payload = buildGPTResponsesPayload(model, [{ role: 'user', content: input.prompt.trim() }], input.attachments ?? []);
  if (!config.apiKey) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider, model, text: '', response: { id: `mock_${provider}_${Date.now()}`, status: 'queued', payload } };
  }
  const timeoutMs = provider === 'pomoai-gpt-prompt' ? POMOAI_PROMPT_GENERATION_TIMEOUT_MS : PROMPT_GENERATION_TIMEOUT_MS;
  const response = await fetcherRequest(dependencies.fetch ?? fetch, providerEndpoint(provider, 'create', env), config.apiKey, payload, true, timeoutMs);
  return { mode: 'live', provider, model, text: normalizeGPTResponsesResponse(response), response };
}

export async function generatePomoAIGPTPrompt(
  input: { model?: string; prompt: string; attachments?: readonly GPTPromptAttachment[] },
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<PromptGenerationResult> {
  return generateResponsesPrompt('pomoai-gpt-prompt', input, dependencies);
}

export async function generateOAIRegboxGPTPrompt(
  input: { model?: string; prompt: string; attachments?: readonly GPTPromptAttachment[] },
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<PromptGenerationResult> {
  return generateResponsesPrompt('oairegbox-gpt-prompt', input, dependencies);
}

/**
 * Generate a child prompt with PomoAI's configured model order. Fallback is
 * intentionally limited to models served by the same PomoAI supplier: an
 * explicit OAIRegBox or BigSnake selection is handled by its own provider
 * function and must never be entered implicitly from this path.
 */
export async function generatePromptWithFallback(
  input: { model?: string; prompt: string; attachments?: readonly GPTPromptAttachment[] },
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<PromptGenerationResult> {
  const requestedModel = input.model?.trim();
  const pomoModels = [...new Set([requestedModel, ...POMOAI_PROMPT_FALLBACK_MODELS].filter((value): value is string => Boolean(value)))];
  const providers = pomoModels.map((model) => ({ provider: 'pomoai-gpt-prompt' as const, model }));
  const attempted: ProviderId[] = [];
  const attemptedModels: string[] = [];
  let lastError: unknown;
  for (const entry of providers) {
    const provider = entry.provider;
    attempted.push(provider);
    try {
      const model = entry.model || getProviderConfig(provider, dependencies.env ?? process.env).model;
      attemptedModels.push(model);
      const result = await generateResponsesPrompt(provider, { ...input, model }, dependencies);
      if (result.mode === 'live' && !result.text.trim()) throw new Error('provider_upstream_failed');
      return {
        ...result,
        fallbackFrom: attempted.length > 1 ? attempted[0] : undefined,
        fallbackProviders: attempted.length > 1 ? ['pomoai-gpt-prompt'] : undefined,
        fallbackModels: attempted.length > 1 ? attemptedModels.slice(0, -1) : undefined,
      };
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error && lastError.message ? lastError.message : 'prompt_provider_failed';
  const aggregate = new Error(message);
  // Keep the terminal attribution tied to the actual supplier and model that
  // were tried last. Do not expose OAIRegBox/BigSnake as implicit fallbacks.
  Object.assign(aggregate, {
    promptProvider: 'pomoai-gpt-prompt',
    promptModel: attemptedModels[attemptedModels.length - 1],
    promptFallbackProviders: attempted.length > 1 ? ['pomoai-gpt-prompt'] : undefined,
    promptFallbackFrom: attempted.length > 1 ? 'pomoai-gpt-prompt' : undefined,
    promptFallbackModels: attemptedModels,
    promptProviderErrors: attempted.map(() => message),
  });
  throw aggregate;
}

/** BigSnake's Responses endpoint is used for child/sub-prompt generation. */
export async function generateBigSnakePrompt(input: { model: string; prompt: string; attachments?: readonly GPTPromptAttachment[] }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; text: string; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const provider: ProviderId = 'bigsnake-prompt';
  const config = getProviderConfig(provider, env);
  const attachments = (input.attachments ?? []).filter((attachment) => Boolean(attachment.dataBase64?.trim()));
  const payload = attachments.length
    ? { ...buildGPTResponsesPayload(input.model, [{ role: 'user' as const, content: input.prompt.trim() }], attachments), max_output_tokens: 2_800 }
    : { model: input.model, input: input.prompt.trim(), max_output_tokens: 2_800 };
  if (!config.apiKey) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider, text: '', response: { id: `mock_bigsnake_${Date.now()}`, status: 'queued', payload } };
  }
  const response = await fetcherRequest(dependencies.fetch ?? fetch, providerEndpoint(provider, 'create', env), config.apiKey, payload, true, BIGSNAKE_PROMPT_GENERATION_TIMEOUT_MS);
  return { mode: 'live', provider, text: normalizeGPTResponsesResponse(response), response };
}

async function fetcherRequest(fetcher: typeof fetch, endpoint: string, apiKey: string, payload: Record<string, unknown>, bearer: boolean, timeoutMs = REQUEST_TIMEOUT_MS, includeGoogleApiKey = !bearer): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'WorkspaceProduction/1.0' };
  headers.authorization = `Bearer ${apiKey}`;
  if (includeGoogleApiKey) headers['x-goog-api-key'] = apiKey;
  let response: Response;
  try {
    response = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch (error) {
    if (isProviderTimeoutError(error)) {
      throw new ProviderRequestError({ code: 'provider_408', endpoint, method: 'POST', receivedAt: new Date().toISOString() });
    }
    throw error;
  }
  if (!response.ok) throw await providerHttpError(response, { endpoint, method: 'POST' });
  return readJsonLimited(response);
}

function isProviderTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name.toLowerCase() : '';
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return name === 'aborterror' || name === 'timeouterror' || message.includes('timed out') || message.includes('timeout') || message.includes('aborted');
}

export async function generateGeminiPrompt(input: { prompt: string; model?: string; references?: readonly GPTPromptAttachment[] }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; text: string; response?: unknown }> {
  const env = dependencies.env ?? process.env;
  const config = getProviderConfig('yuanai-gemini-prompt', env);
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : config.model;
  if (!config.apiKey && isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
  if (!config.apiKey) return { mode: 'mock', text: `${input.prompt.trim()}\n\n镜头稳定，突出商品细节、使用步骤和明确的行动引导。` };
  const endpoint = `${config.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const referenceParts = (input.references ?? [])
    .filter((reference) => Boolean(reference.dataBase64?.trim()))
    .map((reference) => ({ inlineData: { mimeType: reference.mimeType, data: reference.dataBase64 } }));
  const response = await (dependencies.fetch ?? fetch)(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'WorkspaceProduction/1.0' }, body: JSON.stringify({ contents: [{ parts: [...referenceParts, { text: input.prompt.trim() }] }] }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' });
  if (!response.ok) throw await providerHttpError(response, { endpoint, method: 'POST' });
  const payload = await readJsonLimited(response);
  return { mode: 'live', text: normalizeGeminiResponse(payload), response: payload };
}

export async function generateMGRouterImage(input: { model: string; prompt: string; aspectRatio: string; resolution: '1k' | '2k'; referenceImages?: string[] }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? fetch;
  const config = getProviderConfig('mgrouter-grok-image', env);
  const references = validateReferenceUrls(input.referenceImages ?? []);
  const body = buildMGRouterImagePayload({ ...input, referenceImages: references });
  if (!config.apiKey) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider: 'mgrouter-grok-image', response: { id: `mock_image_${Date.now()}`, status: 'queued', payload: body } };
  }
  const endpoint = references.length ? `${config.baseUrl.replace(/\/$/, '')}/images/edits` : providerEndpoint('mgrouter-grok-image', 'create', env);
  return { mode: 'live', provider: 'mgrouter-grok-image', response: await requestProviderWithFetcher(fetcher, endpoint, config.apiKey, body, IMAGE_GENERATION_TIMEOUT_MS) };
}

export async function generateYuanAIImage(input: { model: string; prompt: string; aspectRatio: string; resolution: '1k' | '2k' | '4k'; referenceImages?: string[]; referenceFiles?: MultipartReference[] }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? fetch;
  const config = getProviderConfig('yuanai-image', env);
  const references = validateReferenceUrls(input.referenceImages ?? []);
  const fileReferences = input.referenceFiles ?? [];
  if (fileReferences.length > 0 && references.length > 0) throw new Error('yuanai_reference_sources_conflict');
  const body = fileReferences.length > 0
    ? buildYuanAIImageEditFormData({
      model: input.model,
      prompt: input.prompt,
      size: yuanAIImageSize(input.aspectRatio, input.resolution),
      references: fileReferences,
    })
    : buildYuanAIImagePayload({ ...input, referenceImages: references });
  if (!config.apiKey) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider: 'yuanai-image', response: { id: `mock_yuanai_image_${Date.now()}`, status: 'queued', payload: body } };
  }
  const endpoint = (references.length > 0 || fileReferences.length > 0) ? `${config.baseUrl.replace(/\/$/, '')}/v1/images/edits` : providerEndpoint('yuanai-image', 'create', env);
  if (body instanceof FormData) {
    const response = await fetcher(endpoint, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, body, signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS), cache: 'no-store' });
    if (!response.ok) throw await providerHttpError(response, { endpoint, method: 'POST' });
    return { mode: 'live', provider: 'yuanai-image', response: await readJsonLimited(response) };
  }
  return { mode: 'live', provider: 'yuanai-image', response: await requestProviderWithFetcher(fetcher, endpoint, config.apiKey, body, IMAGE_GENERATION_TIMEOUT_MS) };
}
