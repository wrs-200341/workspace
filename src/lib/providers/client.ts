import { buildGrokVideoPayload, buildSdMiniVideoPayload, buildQualityV4VideoPayload, buildMGRouterImagePayload, buildMGRouterVideoPayload, buildWanVideoPayload, buildMiniMaxVideoPayload, buildYuanAIImagePayload, buildYuanAIImageEditFormData, buildOAIRegboxPayload, buildOAIRegboxMultipartFormData, buildGPTResponsesPayload, type GPTPromptAttachment, type MultipartReference } from './payloads';
import { getProviderConfig, isLiveProvidersAllowed, type ProviderId } from './config';

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
const MAX_VIDEO_CONTENT_BYTES = 200 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 1 * 1024 * 1024;

export function providerEndpoint(id: ProviderId, operation: 'create' | 'status' | 'content', env: Readonly<Record<string, string | undefined>> = process.env): string {
  const base = getProviderConfig(id, env).baseUrl.replace(/\/$/, '');
  if (id === 'grok-video') return operation === 'create' ? `${base}/videos` : `${base}/videos/{id}` + (operation === 'content' ? '/content' : '');
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
  if (id === 'minimax-h3') {
    // Current MiniMax H3 deployments are served by ManjuAI's Wan-compatible
    // gateway (`/videos/generations` + `/videos/tasks/:id`).  Preserve the
    // historical secure-skill gateway shape when an operator explicitly
    // overrides MINIMAX_BASE_URL to that origin.
    const isManjuGateway = (() => { try { return new URL(base).hostname === 'api.manjuai.top'; } catch { return true; } })();
    return isManjuGateway
      ? (operation === 'create' ? `${base}/videos/generations` : `${base}/videos/tasks/{id}`)
      : (operation === 'create' ? `${base}/videos` : `${base}/videos/{id}` + (operation === 'content' ? '/content' : ''));
  }
  if (id === 'yuanai-image') return operation === 'create' ? `${base}/v1/images/generations` : `${base}/v1/images/{id}`;
  if (id === 'pomoai-gemini-image') return `${base}/v1beta/models/${encodeURIComponent(getProviderConfig(id, env).model)}:generateContent`;
  if (id === 'gpt-2999-prompt') return `${base}/v1/responses`;
  if (id === 'oairegbox-omni') return operation === 'create' ? `${base}/videos` : `${base}/videos/{id}` + (operation === 'content' ? '/content' : '');
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
  const outputUrls = [...new Set([...normalizedExplicit, ...collectUrls(root)])]
    .filter((url) => _provider === 'quality-v4' ? /^https?:\/\//i.test(url) : /^https:\/\//i.test(url))
    .map((url) => _provider === 'quality-v4' ? normalizeQualityV4Url(url) : url)
    .filter(Boolean);
  const outputBase64 = collectBase64(root);
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
  const normalizedError = normalizeProviderErrorCode(errorDetails.code, errorDetails.message);
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

function normalizeProviderErrorCode(code: string | undefined, message?: string): string {
  const normalized = `${code ?? ''} ${message ?? ''}`.toLowerCase();
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
async function providerHttpError(response: Response): Promise<Error> {
  let code = `provider_${response.status}`;
  try {
    const text = await readTextLimited(response, MAX_ERROR_RESPONSE_BYTES);
    const payload = JSON.parse(text) as Record<string, unknown>;
    const nested = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : undefined;
    const upstreamCode = String(nested?.code ?? payload.code ?? '').toLowerCase();
    const upstreamMessage = String(nested?.message ?? payload.message ?? '').toLowerCase();
    if (response.status === 401 || upstreamCode.includes('invalid_token') || upstreamCode.includes('invalid_api_key') || upstreamMessage.includes('invalid token')) code = 'provider_unauthorized';
    else if (upstreamCode.includes('image_rejected') || upstreamCode.includes('reference_rejected')) code = 'provider_reference_rejected';
    else if (upstreamCode.includes('content_policy') || upstreamCode.includes('content_review') || upstreamMessage.includes('content review')) code = 'provider_content_policy';
    else if (upstreamCode.includes('model_not_found') || upstreamMessage.includes('no available channel')) code = 'provider_model_unavailable';
    else if (upstreamCode.includes('fail_to_fetch_task') || upstreamCode.includes('upstream_task_failed') || upstreamMessage.includes('fail to fetch task')) code = 'provider_upstream_failed';
    else if (upstreamCode.includes('invalid_request') || upstreamCode.includes('invalid_json') || upstreamMessage.includes('invalid request') || upstreamMessage.includes('invalid json')) code = 'provider_invalid_request';
  } catch { /* keep the HTTP status code */ }
  return new Error(code);
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error('provider_response_too_large');
  const text = await readTextLimited(response, MAX_RESPONSE_BYTES);
  try { return JSON.parse(text); } catch { throw new Error('provider_invalid_json'); }
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
  const response = await fetcher(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!response.ok) throw await providerHttpError(response);
  return readJsonLimited(response);
}

export async function syncProviderTask(provider: ProviderId, providerTaskId: string, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<NormalizedProviderStatus> {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? fetch;
  const config = getProviderConfig(provider, env);
  if (!config.apiKey) throw new Error('provider_not_configured');
  const endpoint = providerEndpoint(provider, 'status', env).replace('{id}', encodeURIComponent(providerTaskId));
  const response = await fetcher(endpoint, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' });
  if (!response.ok) throw await providerHttpError(response);
  return normalizeProviderResponse(provider, await readJsonLimited(response));
}

/**
 * Download a completed video from providers exposing the historical
 * `/videos/{id}/content` endpoint (snumom/Grok, MGRouter, and OAIRegBox). This keeps the
 * provider credential on the server and applies a strict binary size guard;
 * callers can then persist the bytes under the D-drive workspace data root.
 */
export async function downloadProviderVideoContent(
  provider: ProviderId,
  providerTaskId: string,
  dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {},
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (provider !== 'grok-video' && provider !== 'mgrouter-grok-video' && provider !== 'oairegbox-omni') throw new Error('provider_content_unsupported');
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
  if (!response.ok) throw await providerHttpError(response);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_VIDEO_CONTENT_BYTES) throw new Error('provider_response_too_large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > MAX_VIDEO_CONTENT_BYTES) throw new Error('provider_video_content_invalid');
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || 'video/mp4';
  return { bytes, mimeType };
}

export type SubmitVideoInput = { provider: Exclude<ProviderId, 'mgrouter-grok-image' | 'yuanai-gemini-prompt' | 'pomoai-gemini-image' | 'gpt-2999-prompt'>; model: string; prompt: string; duration: number; aspectRatio: string; resolution: string; referenceImages?: string[]; referenceFiles?: MultipartReference[]; referenceAudios?: string[]; referenceVideos?: string[]; media?: Array<{ type: 'reference_image' | 'reference_video' | 'audio'; url: string }> };

export async function submitVideo(input: SubmitVideoInput, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  const isSdMini = input.provider === 'grok-video' && input.model === 'sd-mini';
  const isMiniMax = input.provider === 'minimax-h3';
  const config = getProviderConfig(input.provider, env);
  if (input.provider === 'mgrouter-grok-video' && (input.referenceAudios?.length || input.media?.some((item) => item.type === 'audio'))) {
    throw new Error('mgrouter_reference_audio_unsupported');
  }
  if (isSdMini && (input.referenceAudios?.length || input.referenceFiles?.length || input.media?.some((item) => item.type !== 'reference_image'))) {
    throw new Error('sdmini_reference_media_unsupported');
  }
  if (isMiniMax && !config.baseUrl.includes('api.manjuai.top') && (input.referenceFiles?.length || input.media?.some((item) => item.type === 'reference_video'))) {
    throw new Error('minimax_reference_media_unsupported');
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
    ? (config.baseUrl.includes('api.manjuai.top')
      ? buildWanVideoPayload({
        model: input.model,
        prompt: input.prompt.trim(),
        duration: input.duration,
        ratio: input.aspectRatio,
        resolution: input.resolution,
        media: [
          ...references.map((url) => ({ type: 'reference_image' as const, url })),
          ...validateReferenceUrls(input.referenceVideos ?? []).map((url) => ({ type: 'reference_video' as const, url })),
          ...validateReferenceUrls(input.referenceAudios ?? []).map((url) => ({ type: 'audio' as const, url })),
        ],
      })
      : buildMiniMaxVideoPayload({ model: input.model, prompt: input.prompt.trim(), duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references, referenceAudios: validateReferenceUrls(input.referenceAudios ?? []) }))
    : isSdMini
    ? buildSdMiniVideoPayload({ model: input.model, prompt: input.prompt.trim(), seconds: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: references })
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
    const response = await (dependencies.fetch ?? fetch)(providerEndpoint(input.provider, 'create', env), { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'WorkspaceProduction/1.0' }, body, signal: AbortSignal.timeout(25_000), cache: 'no-store' });
    if (!response.ok) throw await providerHttpError(response);
    return { mode: 'live', provider: input.provider, response: await readJsonLimited(response) };
  }
  return { mode: 'live', provider: input.provider, response: await requestProviderWithFetcher(dependencies.fetch ?? fetch, providerEndpoint(input.provider, 'create', env), config.apiKey, body) };
}

export async function generatePomoAIImage(input: { model: string; prompt: string; references?: Array<{ mimeType: string; dataBase64: string }> }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; provider: ProviderId; response: unknown }> {
  const env = dependencies.env ?? process.env;
  if ((input.references ?? []).length > 3) throw new Error('too_many_reference_images');
  const live = env.WORKSPACE_ENABLE_LIVE_PROVIDERS === 'true' && Boolean(env.POMOAI_API_KEY?.trim());
  const payload = { contents: [{ parts: [...(input.references ?? []).map((reference) => ({ inlineData: { mimeType: reference.mimeType, data: reference.dataBase64 } })), { text: input.prompt.trim() }] }] };
  if (!live) {
    if (isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
    return { mode: 'mock', provider: 'pomoai-gemini-image', response: { id: `mock_pomo_${Date.now()}`, status: 'queued', payload } };
  }
  const base = getProviderConfig('pomoai-gemini-image', env).baseUrl;
  const endpoint = `${base}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const response = await fetcherRequest(dependencies.fetch ?? fetch, endpoint, env.POMOAI_API_KEY!.trim(), payload, false, IMAGE_GENERATION_TIMEOUT_MS);
  return { mode: 'live', provider: 'pomoai-gemini-image', response };
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

async function fetcherRequest(fetcher: typeof fetch, endpoint: string, apiKey: string, payload: Record<string, unknown>, bearer: boolean, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'WorkspaceProduction/1.0' };
  if (bearer) headers.authorization = `Bearer ${apiKey}`; else { headers.authorization = `Bearer ${apiKey}`; headers['x-goog-api-key'] = apiKey; }
  const response = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!response.ok) throw await providerHttpError(response);
  return readJsonLimited(response);
}

export async function generateGeminiPrompt(input: { prompt: string; model?: string }, dependencies: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch } = {}): Promise<{ mode: 'live' | 'mock'; text: string; response?: unknown }> {
  const env = dependencies.env ?? process.env;
  const config = getProviderConfig('yuanai-gemini-prompt', env);
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : config.model;
  if (!config.apiKey && isLiveProvidersAllowed(env)) throw new Error('provider_not_configured');
  if (!config.apiKey) return { mode: 'mock', text: `${input.prompt.trim()}\n\n镜头稳定，突出商品细节、使用步骤和明确的行动引导。` };
  const endpoint = `${config.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const response = await (dependencies.fetch ?? fetch)(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'WorkspaceProduction/1.0' }, body: JSON.stringify({ contents: [{ parts: [{ text: input.prompt.trim() }] }] }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' });
  if (!response.ok) throw await providerHttpError(response);
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
      size: input.resolution === '4k' ? '4096x4096' : input.resolution === '2k' ? '2048x2048' : '1024x1024',
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
    if (!response.ok) throw await providerHttpError(response);
    return { mode: 'live', provider: 'yuanai-image', response: await readJsonLimited(response) };
  }
  return { mode: 'live', provider: 'yuanai-image', response: await requestProviderWithFetcher(fetcher, endpoint, config.apiKey, body, IMAGE_GENERATION_TIMEOUT_MS) };
}
