import type { ProviderId } from './config';

export type GrokVideoInput = { model: string; prompt: string; duration: number; aspectRatio: string; resolution: string; referenceImages: string[] };
/**
 * Input contract for snumom's sd-mini video model.  Unlike the historical
 * Grok models, sd-mini uses top-level `seconds`/`resolution`/`aspect_ratio`
 * fields and accepts reference images through `image_urls`.
 */
export type SdMiniVideoInput = {
  model: string;
  prompt: string;
  /** Canonical supplier field. */
  seconds?: number;
  /** Compatibility alias accepted by workspace callers. */
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  referenceImages?: readonly string[];
};
export type MGRouterImageInput = { model: string; prompt: string; aspectRatio: string; resolution: '1k' | '2k'; referenceImages: string[] };
export type MGRouterVideoInput = { model: string; prompt: string; aspectRatio: string; resolution: string; duration: number; referenceImages: string[]; referenceAudios: string[] };
export type WanVideoInput = { model: string; prompt: string; ratio: string; resolution: string; duration: number; media: Array<{ type: 'reference_image' | 'reference_video' | 'audio'; url: string }> };
/** MiniMax H3 gateway contract recovered from the historical production desk. */
export type MiniMaxVideoInput = {
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution?: string;
  referenceImages?: readonly string[];
  referenceAudios?: readonly string[];
};
/** Pro666 sd2-933-mini fixed 12s/720p portrait contract. */
export type Pro666VideoInput = {
  prompt: string;
  images?: readonly string[];
  audios?: readonly string[];
};
/** Quality V4 (video2.crack.cc.cd) request contract. */
export type QualityV4VideoInput = {
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  size: string;
  referenceImages?: readonly string[];
  referenceVideos?: readonly string[];
  referenceAudios?: readonly string[];
};
export type YuanAIImageInput = { model: string; prompt: string; aspectRatio: string; resolution: '1k' | '2k' | '4k'; referenceImages: string[] };

/** Inline image part used by the PomoAI Gemini 3.1 Flash Image endpoint. */
export type PomoAIImageReference = { mimeType: string; dataBase64: string };
export type PomoAIImageInput = { model: string; prompt: string; references?: readonly PomoAIImageReference[]; aspectRatio?: string; resolution?: string };
export type GPTPromptAttachment = { name?: string; mimeType: string; dataBase64?: string; text?: string };

/** A validated local file used to construct provider multipart requests. */
export type MultipartReference = { bytes: Uint8Array; mimeType: string; fileName: string };
export type YuanAIImageEditInput = { model: string; prompt: string; size: string; quality?: 'low' | 'high'; n?: number; references: readonly MultipartReference[] };
export type OAIRegboxInput = { model: string; prompt: string; duration: number; aspectRatio: string; references?: readonly MultipartReference[] };
export type OpenAIImageInput = {
  model: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high';
  n?: number;
  responseFormat?: 'url' | 'b64_json';
  /** Use OriginGateway's documented 4K canvas sizes. */
  originGateway?: boolean;
};

/** OpenAI-compatible image generation payloads used by OriginGateway/Junze. */
export function buildOpenAIImagePayload(input: OpenAIImageInput): Record<string, unknown> {
  const ratio = input.aspectRatio?.trim() || '1:1';
  const resolution = input.resolution?.trim().toLowerCase() || '1k';
  const isGrok = input.model.toLowerCase().includes('grok');
  const origin4kSizes: Record<string, string> = {
    '1:1': '2880x2880',
    '5:4': '3200x2560',
    '4:5': '2560x3200',
    '4:3': '3264x2448',
    '3:4': '2448x3264',
    '3:2': '3504x2336',
    '2:3': '2336x3504',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '21:9': '3696x1584',
  };
  const size = isGrok
    ? (ratio === '9:16' ? '9:16' : '1024x1024')
    : input.originGateway && resolution === '4k'
      ? origin4kSizes[ratio] || origin4kSizes['1:1']
    : ratio === '9:16'
      ? '1152x2048'
      : ratio === '16:9'
        ? (resolution === '4k' ? '3840x2160' : resolution === '2k' ? '2730x1536' : '1536x864')
        : resolution === '4k' ? '2048x2048' : resolution === '2k' ? '2048x2048' : '1024x1024';
  return {
    model: input.model,
    prompt: input.prompt.trim(),
    n: input.n ?? 1,
    size,
    quality: isGrok ? (input.quality === 'low' ? 'low' : 'medium') : (input.quality === 'medium' ? 'high' : input.quality ?? 'high'),
    response_format: input.responseFormat ?? 'url',
  };
}

export type OpenAIImageEditInput = OpenAIImageInput & {
  referenceImages?: readonly string[];
  referenceFiles?: readonly MultipartReference[];
};

/** Build the documented JSON form of OriginGateway's image-edit request. */
export function buildOpenAIImageEditPayload(input: OpenAIImageEditInput): Record<string, unknown> {
  const references = [...(input.referenceImages ?? [])];
  if (references.length === 0) throw new Error('origin_reference_required');
  const generation = buildOpenAIImagePayload({ ...input, originGateway: true });
  const cleanPayload: Record<string, unknown> = { ...generation };
  if (references.length === 1) cleanPayload.image = references[0];
  else cleanPayload.images = references;
  return cleanPayload;
}

/** Build OriginGateway's multipart image-edit request for local assets. */
export function buildOpenAIImageEditFormData(input: OpenAIImageEditInput): FormData {
  const files = [...(input.referenceFiles ?? [])];
  const urls = [...(input.referenceImages ?? [])];
  if (files.length + urls.length === 0) throw new Error('origin_reference_required');
  const generation = buildOpenAIImagePayload({ ...input, originGateway: true });
  const form = new FormData();
  form.set('model', String(generation.model));
  form.set('prompt', String(generation.prompt));
  form.set('n', String(generation.n ?? 1));
  form.set('size', String(generation.size));
  form.set('quality', String(generation.quality));
  form.set('response_format', String(generation.response_format ?? 'url'));
  const appendFile = (field: string, reference: MultipartReference) => {
    form.append(field, new Blob([Uint8Array.from(reference.bytes).buffer as ArrayBuffer], { type: reference.mimeType }), reference.fileName);
  };
  if (files.length + urls.length === 1 && files.length === 1) appendFile('image', files[0]);
  else {
    urls.forEach((url) => form.append('image[]', url));
    files.forEach((reference) => appendFile('image[]', reference));
  }
  return form;
}

/** Gemini native image request shared by PomoAI and Junze/Origin Nano. */
export function buildGeminiNativeImagePayload(input: PomoAIImageInput): Record<string, unknown> {
  const referenceParts = (input.references ?? []).map((reference) => ({ inlineData: { mimeType: reference.mimeType, data: reference.dataBase64 } }));
  const imageConfig = input.aspectRatio || input.resolution
    ? { imageConfig: { ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}), ...(input.resolution ? { imageSize: input.resolution.toUpperCase() } : {}) } }
    : {};
  return {
    contents: [{ role: 'user', parts: [...referenceParts, { text: input.prompt.trim() }] }],
    generationConfig: { responseModalities: ['IMAGE'], ...imageConfig },
  };
}

/** OriginGateway Nano Banana square/chat compatibility request. */
export function buildOriginNanoChatPayload(model: string, prompt: string): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: prompt.trim() }], max_tokens: 64 };
}

export function buildPomoAIImagePayload(input: PomoAIImageInput): Record<string, unknown> {
  const referenceParts = (input.references ?? []).map((reference) => ({
    inlineData: { mimeType: reference.mimeType, data: reference.dataBase64 },
  }));
  const imageConfig = input.aspectRatio || input.resolution
    ? { imageConfig: { ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}), ...(input.resolution ? { imageSize: input.resolution.toUpperCase() } : {}) } }
    : undefined;
  return { contents: [{ parts: [...referenceParts, { text: input.prompt.trim() }] }], ...(imageConfig ? { generationConfig: imageConfig } : {}) };
}

export function buildYuanAIImageEditFormData(input: YuanAIImageEditInput): FormData {
  if (input.references.length === 0) throw new Error('yuanai_reference_required');
  const form = new FormData();
  form.set('model', input.model);
  form.set('prompt', input.prompt.trim());
  form.set('n', String(input.n ?? 1));
  form.set('size', input.size);
  form.set('response_format', 'b64_json');
  if (input.quality === 'high') form.set('quality', input.quality);
  const field = input.references.length === 1 ? 'image' : 'image[]';
  for (const reference of input.references) {
    form.append(field, new Blob([Uint8Array.from(reference.bytes).buffer as ArrayBuffer], { type: reference.mimeType }), reference.fileName);
  }
  return form;
}

/**
 * YuanAI accepts an explicit pixel size for both normal generations and
 * reference-image edits. Keep the ratio in the size itself because the
 * gateway otherwise falls back to a square canvas even when aspect_ratio is
 * present. The 1K/2K values follow the provider's portrait/landscape canvas
 * convention; 4K uses the documented 2160x3840 / 3840x2160 canvases.
 */
export function yuanAIImageSize(aspectRatio: string, resolution: '1k' | '2k' | '4k'): string {
  const normalizedRatio = aspectRatio.trim();
  const portrait = normalizedRatio === '9:16' || normalizedRatio === '3:4';
  const landscape = normalizedRatio === '16:9' || normalizedRatio === '4:3';
  if (resolution === '4k') {
    if (portrait) return '2160x3840';
    if (landscape) return '3840x2160';
    return '2048x2048';
  }
  if (resolution === '2k') {
    if (portrait) return '2048x3072';
    if (landscape) return '3072x2048';
    return '2048x2048';
  }
  if (portrait) return '1024x1536';
  if (landscape) return '1536x1024';
  return '1024x1024';
}

export function buildGPTPromptPayload(model: string, messages: readonly { role: 'user' | 'assistant' | 'system'; content: string }[]): Record<string, unknown> {
  return { model, messages: messages.map((message) => ({ role: message.role, content: message.content })) };
}

/**
 * Build the OpenAI Responses API request envelope used by the GPT-2999
 * provider. Responses expects an `input` array whose message content is
 * represented by typed `input_text` blocks (rather than Chat Completions'
 * string `messages[].content`).
 */
export function buildGPTResponsesPayload(
  model: string,
  messages: readonly { role: 'user' | 'assistant' | 'system'; content: string }[],
  attachments: readonly GPTPromptAttachment[] = [],
): Record<string, unknown> {
  let lastUserIndex = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return {
    model,
    input: messages.map((message, index) => ({
      role: message.role,
      content: [
        { type: 'input_text', text: message.content },
        ...(index === lastUserIndex ? attachments.flatMap((attachment) => {
          const blocks: Array<Record<string, string>> = [];
          if (attachment.dataBase64) blocks.push({ type: 'input_image', image_url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` });
          if (attachment.text?.trim()) {
            const label = attachment.name?.trim() ? `[参考文件：${attachment.name.trim()}]` : '[参考文件]';
            blocks.push({ type: 'input_text', text: `${label}\n${attachment.text.trim()}` });
          }
          return blocks;
        }) : []),
      ],
    })),
    max_output_tokens: 2_800,
  };
}

export function buildOAIRegboxPayload(input: OAIRegboxInput): Record<string, unknown> {
  if ((input.references ?? []).length > 0) throw new Error('oairegbox_references_require_multipart');
  // OAIRegBox's JSON schema advertises seconds as string/int, but the live
  // gateway rejects numeric JSON (`invalid JSON request body`). Serialize the
  // validated duration exactly as the documented curl/Python examples do.
  return { model: input.model, prompt: input.prompt.trim(), seconds: String(input.duration), aspect_ratio: input.aspectRatio };
}

export function buildOAIRegboxMultipartFormData(input: OAIRegboxInput): FormData {
  const references = input.references ?? [];
  if (references.length === 0) throw new Error('oairegbox_reference_required');
  if (references.length > 5) throw new Error('oairegbox_too_many_references');
  const form = new FormData();
  form.set('model', input.model);
  form.set('prompt', input.prompt.trim());
  form.set('seconds', String(input.duration));
  form.set('aspect_ratio', input.aspectRatio);
  for (const reference of references) {
    form.append('input_reference[]', new Blob([Uint8Array.from(reference.bytes).buffer as ArrayBuffer], { type: reference.mimeType }), reference.fileName);
  }
  return form;
}

/** Build the recovered MiniMax H3 gateway contract.
 * The gateway accepts public HTTPS media URLs and uses duration/ratio
 * fields (not the Wan media envelope or Grok extra object).
 */
export function buildMiniMaxVideoPayload(input: MiniMaxVideoInput): Record<string, unknown> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('minimax_prompt_required');
  if (!Number.isInteger(input.duration) || input.duration < 4 || input.duration > 15) throw new Error('minimax_invalid_duration');
  const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  if (!ratios.includes(input.aspectRatio)) throw new Error('minimax_invalid_aspect_ratio');
  const images = [...(input.referenceImages ?? [])];
  const audios = [...(input.referenceAudios ?? [])];
  if (images.length > 5) throw new Error('minimax_too_many_reference_images');
  if (audios.length > 3) throw new Error('minimax_too_many_reference_audios');
  for (const url of [...images, ...audios]) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('minimax_reference_urls_must_be_https'); }
    if (parsed.protocol !== 'https:') throw new Error('minimax_reference_urls_must_be_https');
  }
  return {
    model: input.model,
    prompt,
    resolution: (input.resolution ?? '720p').toLowerCase(),
    duration: input.duration,
    ratio: input.aspectRatio,
    ...(images.length ? { image_urls: images } : {}),
    ...(audios.length ? { audio_urls: audios } : {}),
  };
}

export function buildPro666VideoPayload(input: Pro666VideoInput): Record<string, unknown> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('pro666_prompt_required');
  const images = [...(input.images ?? [])];
  const audios = [...(input.audios ?? [])];
  if (images.length > 1) throw new Error('pro666_too_many_reference_images');
  if (audios.length > 1) throw new Error('pro666_too_many_reference_audios');
  for (const url of [...images, ...audios]) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('pro666_reference_urls_must_be_https'); }
    if (parsed.protocol !== 'https:') throw new Error('pro666_reference_urls_must_be_https');
  }
  return {
    model: 'sd2-933-mini',
    prompt,
    duration: 12,
    resolution: '720p',
    aspect_ratio: '9:16',
    generateAudio: true,
    ...(images.length ? { images } : {}),
    ...(audios.length ? { audios } : {}),
  };
}

export function buildQualityV4VideoPayload(input: QualityV4VideoInput): Record<string, unknown> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('qualityv4_prompt_required');
  if (!Number.isInteger(input.duration) || ![5, 10, 15].includes(input.duration)) throw new Error('qualityv4_invalid_duration');
  const resolution = input.resolution.trim().toLowerCase();
  if (!['480p', '720p'].includes(resolution)) throw new Error('qualityv4_invalid_resolution');
  if (resolution === '720p' && input.duration !== 10) throw new Error('qualityv4_720p_requires_10s');
  const sizes = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'];
  if (!sizes.includes(input.size)) throw new Error('qualityv4_invalid_size');
  const images = [...(input.referenceImages ?? [])];
  const videos = [...(input.referenceVideos ?? [])];
  const audios = [...(input.referenceAudios ?? [])];
  if (images.length > 9) throw new Error('qualityv4_too_many_reference_images');
  if (videos.length > 3) throw new Error('qualityv4_too_many_reference_videos');
  if (audios.length > 3) throw new Error('qualityv4_too_many_reference_audios');
  // Quality V4 auto-detects media type from each URL/data URI/base64 value;
  // its documented contract is a flat `images` string array, not typed
  // objects. Keep the source order so @image/@video/@audio references remain
  // deterministic.
  const media = [...images, ...videos, ...audios];
  return {
    model: input.model || 'quality-v4',
    prompt,
    mode: 'reference',
    ref_model: 'quality-v4',
    duration: input.duration,
    resolution,
    size: input.size,
    ...(media.length ? { images: media } : {}),
  };
}

export function buildGrokVideoPayload(input: GrokVideoInput): Record<string, unknown> {
  const extra: Record<string, unknown> = { aspect_ratio: input.aspectRatio, resolution: input.resolution };
  const payload: Record<string, unknown> = { model: input.model, prompt: input.prompt, duration: input.duration, extra };
  if (input.referenceImages.length === 1) payload.input_reference = input.referenceImages[0];
  if (input.referenceImages.length > 1) extra.reference_images = input.referenceImages.map((url) => ({ url, role: 'reference_image' }));
  return payload;
}

/**
 * Build the native snumom sd-mini request payload.
 *
 * The provider deliberately keeps this contract separate from the legacy
 * Grok payload: sd-mini rejects `duration`/`extra` and expects `seconds`,
 * `resolution`, and `aspect_ratio` at the top level.  Reference-image mode
 * is selected from the number of images as documented by the supplier.
 */
export function buildSdMiniVideoPayload(input: SdMiniVideoInput): Record<string, unknown> {
  if (input.model !== 'sd-mini') throw new Error('sdmini_model_invalid');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('sdmini_prompt_required');
  const seconds = input.seconds ?? input.duration;
  if (seconds === undefined || !Number.isInteger(seconds) || ![5, 10, 15].includes(seconds)) throw new Error('sdmini_invalid_seconds');

  const resolution = (input.resolution ?? (seconds === 10 ? '720p' : '480p')).trim().toLowerCase();
  if (!['480p', '720p'].includes(resolution)) throw new Error('sdmini_invalid_resolution');
  if (resolution === '720p' && seconds !== 10) throw new Error('sdmini_720p_requires_10s');

  const aspectRatio = (input.aspectRatio ?? '9:16').trim();
  const allowedAspectRatios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'auto'];
  if (!allowedAspectRatios.includes(aspectRatio)) throw new Error('sdmini_invalid_aspect_ratio');

  const references = [...(input.referenceImages ?? [])];
  if (references.length > 7) throw new Error('sdmini_too_many_reference_images');
  if (references.some((url) => typeof url !== 'string' || !/^https?:\/\//i.test(url))) {
    throw new Error('sdmini_reference_images_must_be_http');
  }

  const payload: Record<string, unknown> = {
    model: 'sd-mini',
    prompt,
    // snumom's sd-mini gateway declares this field as a string in its
    // OpenAI-compatible schema (numeric JSON values are rejected before task
    // creation), so serialize the validated integer explicitly.
    seconds: String(seconds),
    resolution,
    aspect_ratio: aspectRatio,
  };
  if (references.length > 0) {
    payload.image_urls = references;
    payload.mode = references.length === 1
      ? 'start_image'
      : references.length === 2
        ? 'between_images'
        : 'reference_images';
  }
  return payload;
}

export function normalizeAudioPlaceholders(prompt: string, audioCount = 0): string { if (audioCount <= 0) return prompt.trim(); return Array.from({ length: Math.min(audioCount, 2) }, (_, index) => `<AUDIO_${index}>`).reduce((value, marker) => value.includes(marker) ? value : `${value.trim()} ${marker}`, prompt.trim()).trim(); }
export function buildMGRouterImagePayload(input: MGRouterImageInput): Record<string, unknown> { return { model: input.model, prompt: input.prompt, aspect_ratio: input.aspectRatio, resolution: input.resolution, ...(input.referenceImages.length ? { images: input.referenceImages.map((url) => ({ url })) } : {}) }; }
export function buildMGRouterVideoPayload(input: MGRouterVideoInput): Record<string, unknown> {
  // MGRouter's /v1/models catalog exposes Grok Imagine Video 1.5.  Accept the
  // historical `grok-video` alias from restored tasks, but send the canonical
  // model id whenever callers omit or pass that alias.
  const model = input.model.trim() === '' || input.model === 'grok-video' ? 'grok-imagine-video-1.5' : input.model;
  return {
    model,
    prompt: normalizeAudioPlaceholders(input.prompt, input.referenceAudios.length),
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
    duration: input.duration,
    ...(input.referenceImages.length ? { reference_images: input.referenceImages } : {}),
    ...(input.referenceAudios.length ? { reference_audios: input.referenceAudios.map((url) => ({ url })) } : {}),
  };
}
export function buildWanVideoPayload(input: WanVideoInput): Record<string, unknown> {
  // ManjuAI documents resolution values as case-insensitive, but its API
  // responses and historical implementation consistently use upper-case
  // (480P/720P/1080P). Normalize here so browser input such as "480p"
  // produces the canonical request accepted by every Wan deployment.
  const media = input.media.map((item) => ({ ...item }));
  return {
    model: input.model,
    prompt: input.prompt,
    ...(media.length > 0 ? { media } : {}),
    resolution: input.resolution.toUpperCase(),
    ratio: input.ratio,
    duration: input.duration,
    prompt_extend: true,
  };
}

export function buildYuanAIImagePayload(input: YuanAIImageInput): Record<string, unknown> {
  return {
    model: input.model,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
    size: yuanAIImageSize(input.aspectRatio, input.resolution),
    ...(input.referenceImages.length ? { images: input.referenceImages } : {}),
  };
}
export function providerKind(id: ProviderId): 'image' | 'video' | 'prompt' { if (id === 'mgrouter-grok-image' || id === 'yuanai-image' || id === 'pomoai-gemini-image' || id === 'origin-gpt-image' || id === 'origin-grok-image' || id === 'origin-nano-image' || id === 'junze-gpt-image' || id === 'junze-gemini-image') return 'image'; if (id === 'yuanai-gemini-prompt' || id === 'gpt-2999-prompt' || id === 'bigsnake-prompt') return 'prompt'; return 'video'; }
