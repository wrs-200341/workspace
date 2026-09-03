import { describe, expect, it, vi } from 'vitest';
import { normalizeGeminiResponse, normalizeGPTResponsesResponse, normalizeProviderResponse, providerEndpoint, providerErrorInfo, providerResponseSnapshot, sanitizeProviderError, validateReferenceUrls, generatePomoAIImage, generateYuanAIImage, generateGPTPrompt, submitVideo, downloadProviderVideoContent, generateMGRouterImage } from './client';

describe('provider client helpers', () => {
  it('normalizes Gemini candidate text', () => {
    expect(normalizeGeminiResponse({ candidates: [{ content: { parts: [{ text: 'first' }, { text: 'second' }] } }] })).toBe('first\nsecond');
    expect(normalizeGeminiResponse({ candidates: [] })).toBe('');
  });

  it('rejects local or non-https reference URLs', () => {
    expect(validateReferenceUrls([])).toEqual([]);
    expect(() => validateReferenceUrls(['C:\\tmp\\image.jpg'])).toThrow(/https/);
    expect(() => validateReferenceUrls(['http://example.com/a.jpg'])).toThrow(/https/);
    expect(validateReferenceUrls(['https://assets.example/a.jpg'])).toEqual(['https://assets.example/a.jpg']);
  });

  it('uses fixed provider endpoints and redacts upstream errors', () => {
    expect(providerEndpoint('grok-video', 'create')).toBe('https://snumom.com/v1/videos');
    expect(providerEndpoint('mgrouter-grok-image', 'create')).toBe('https://raw.mgrouter.com/v1/images/generations');
    expect(providerEndpoint('mgrouter-grok-video', 'create')).toBe('https://raw.mgrouter.com/v1/videos/generations');
    expect(providerEndpoint('mgrouter-grok-video', 'status')).toBe('https://raw.mgrouter.com/v1/videos/{id}');
    expect(providerEndpoint('mgrouter-grok-video', 'content')).toBe('https://raw.mgrouter.com/v1/videos/{id}/content');
    expect(providerEndpoint('wan3-video', 'create')).toBe('https://api.manjuai.top/v1/videos/generations');
    expect(providerEndpoint('wan3-video', 'create', { WAN_BASE_URL: 'https://api.manjuai.top/v1' })).toBe('https://api.manjuai.top/v1/videos/generations');
    expect(providerEndpoint('pomoai-gemini-image', 'create')).toBe('https://www.pomoai.ai/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(providerEndpoint('gpt-2999-prompt', 'create')).toBe('https://2999api.com/v1/responses');
    expect(providerEndpoint('oairegbox-omni', 'create')).toBe('https://newapi-2.oairegbox.cc/v1/videos');
    expect(providerEndpoint('minimax-h3', 'create')).toBe('https://api.manjuai.top/v1/videos/generations');
    expect(providerEndpoint('minimax-h3', 'status')).toBe('https://api.manjuai.top/v1/videos/tasks/{id}');
    expect(sanitizeProviderError('Bearer secret-token: provider failed')).toBe('provider request failed');
  });

  it('retains the bounded raw supplier response for a rejected request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'content_policy', message: 'blocked by review' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    let caught: unknown;
    try {
      await generateMGRouterImage({ model: 'grok-image', prompt: 'demo', aspectRatio: '1:1', resolution: '1k' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MGROUTER_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    } catch (error) { caught = error; }
    const info = providerErrorInfo(caught);
    expect(info.status).toBe(400);
    expect(info.rawBody).toContain('content_policy');
    expect(providerResponseSnapshot(caught).body).toEqual({ error: { code: 'content_policy', message: 'blocked by review' } });
  });

  it('retains a successful HTTP response body when the supplier returns invalid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('gateway returned plain text', { status: 200, headers: { 'content-type': 'text/plain' } }));
    let caught: unknown;
    try {
      await generateMGRouterImage({ model: 'grok-image', prompt: 'demo', aspectRatio: '1:1', resolution: '1k' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MGROUTER_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    } catch (error) { caught = error; }
    expect(providerResponseSnapshot(caught).code).toBe('provider_invalid_json');
    expect(providerResponseSnapshot(caught).rawBody).toBe('gateway returned plain text');
  });

  it('submits PomoAI Gemini image requests with inline image parts', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'x-goog-api-key': 'test-key' });
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts.at(-1)).toEqual({ text: 'draw' });
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] });
    });
    const result = await generatePomoAIImage({ model: 'gemini-3.1-flash-image', prompt: 'draw', references: [] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', POMOAI_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits YuanAI 4K JSON generation without downgrading the resolution', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2', resolution: '4k', aspect_ratio: '1:1' });
      return Response.json({ data: [{ b64_json: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' }] });
    });
    const result = await generateYuanAIImage({ model: 'gpt-image-2', prompt: 'product', aspectRatio: '1:1', resolution: '4k' }, {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_API_KEY: 'test-key' },
      fetch: fetchMock as typeof fetch,
    });
    expect(result.mode).toBe('live');
  });

  it('maps YuanAI 4K square reference edits to a 2048x2048 multipart size', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get('size')).toBe('2048x2048');
      expect(body.get('model')).toBe('gpt-image-2');
      expect(body.get('image')).toBeInstanceOf(File);
      return Response.json({ data: [{ b64_json: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' }] });
    });
    const result = await generateYuanAIImage({ model: 'gpt-image-2', prompt: 'edit', aspectRatio: '1:1', resolution: '4k', referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }] }, {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_API_KEY: 'test-key' },
      fetch: fetchMock as typeof fetch,
    });
    expect(result.mode).toBe('live');
  });

  it('submits YuanAI gpt-image-2 generation requests with the documented JSON contract', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://yuanai.uk/v1/images/generations');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-image-2', prompt: 'draw', aspect_ratio: '1:1', resolution: '1k', size: '1024x1024',
      });
      return Response.json({ created: 1, data: [{ b64_json: 'YWJj' }] });
    });
    const result = await generateYuanAIImage({ model: 'gpt-image-2', prompt: 'draw', aspectRatio: '1:1', resolution: '1k' }, {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_API_KEY: 'test-key' },
      fetch: fetchMock as typeof fetch,
    });
    expect(result.mode).toBe('live');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits YuanAI gpt-image-2 edits as multipart when local reference bytes are supplied', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://yuanai.uk/v1/images/edits');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-image-2');
      expect(form.get('prompt')).toBe('edit');
      expect(form.get('image')).toBeInstanceOf(File);
      return Response.json({ created: 1, data: [{ b64_json: 'YWJj' }] });
    });
    const result = await generateYuanAIImage({
      model: 'gpt-image-2', prompt: 'edit', aspectRatio: '1:1', resolution: '1k',
      referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('maps YuanAI 4k square reference-image edits to a 2048x2048 multipart size', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('size')).toBe('2048x2048');
      expect(form.get('model')).toBe('gpt-image-2');
      expect(form.get('image')).toBeInstanceOf(File);
      return Response.json({ created: 1, data: [{ b64_json: 'YWJj' }] });
    });
    const result = await generateYuanAIImage({
      model: 'gpt-image-2', prompt: 'upscale this product image', aspectRatio: '1:1', resolution: '4k' as never,
      referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('maps YuanAI portrait reference edits to a portrait multipart size', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('size')).toBe('2160x3840');
      return Response.json({ created: 1, data: [{ b64_json: 'YWJj' }] });
    });
    await expect(generateYuanAIImage({
      model: 'gpt-image-2', prompt: 'portrait', aspectRatio: '9:16', resolution: '4k',
      referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).resolves.toMatchObject({ mode: 'live' });
  });

  it('submits GPT-2999 prompt requests using Responses API', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://2999api.com/v1/responses');
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        max_output_tokens: 2800,
      });
      return Response.json({ output_text: 'world' });
    });
    const result = await generateGPTPrompt({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GPT_PROMPT_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toEqual(expect.objectContaining({ mode: 'live', text: 'world' }));
  });

  it('does not route provider credentials to an untrusted override origin', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://2999api.com/v1/responses');
      return Response.json({ output_text: 'safe' });
    });
    const result = await generateGPTPrompt({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GPT_PROMPT_API_KEY: 'test-key', GPT_PROMPT_BASE_URL: 'https://evil.example' }, fetch: fetchMock as typeof fetch });
    expect(result.text).toBe('safe');
  });

  it('normalizes structured Responses output and Chat Completions fallback', () => {
    expect(normalizeGPTResponsesResponse({
      output: [{ content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }] }],
    })).toBe('first\nsecond');
    expect(normalizeGPTResponsesResponse({ choices: [{ message: { content: [{ text: 'fallback' }] } }] })).toBe('fallback');
    expect(normalizeGPTResponsesResponse({})).toBe('');
  });

  it('requires binary references for OAIRegBox multipart requests', async () => {
    await expect(submitVideo({ provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720p', referenceImages: ['https://assets.example/a.png'] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('reference_files_required');
  });

  it('submits OAIRegBox JSON when no references are provided', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'omni-fast-no-water', prompt: 'demo', seconds: '10', aspect_ratio: '16:9' });
      return Response.json({ id: 'omni-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720p' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('submits MiniMax H3 requests through the ManjuAI gateway', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.manjuai.top/v1/videos/generations');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'minimax-h3-r2v', prompt: 'demo', ratio: '16:9', resolution: '720P', duration: 10,
        media: [{ type: 'reference_image', url: 'https://assets.example/a.png' }], prompt_extend: true,
      });
      return Response.json({ id: 'minimax-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'minimax-h3', model: 'minimax-h3-r2v', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720P', referenceImages: ['https://assets.example/a.png'] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MINIMAX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'minimax-h3' });
  });

  it('passes video and audio references for MiniMax R2V on the ManjuAI gateway', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        media: [
          { type: 'reference_image', url: 'https://assets.example/a.png' },
          { type: 'reference_video', url: 'https://assets.example/a.mp4' },
          { type: 'audio', url: 'https://assets.example/a.mp3' },
        ],
      });
      return Response.json({ id: 'minimax-r2v-task', status: 'queued' });
    });
    await expect(submitVideo({
      provider: 'minimax-h3', model: 'minimax-h3-r2v', prompt: 'demo', duration: 10,
      aspectRatio: '16:9', resolution: '720P',
      referenceImages: ['https://assets.example/a.png'],
      referenceVideos: ['https://assets.example/a.mp4'],
      referenceAudios: ['https://assets.example/a.mp3'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MINIMAX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).resolves.toMatchObject({ mode: 'live', provider: 'minimax-h3' });
  });

  it('submits OAIRegBox multipart files without overriding the multipart boundary', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get('input_reference[]')).toBeInstanceOf(File);
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
      expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
      return Response.json({ id: 'omni-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720p', referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('submits the tested snumom Grok image-to-video contract through the live adapter', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://snumom.com/v1/videos');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'grok-imagine-video-1.5（按次）',
        prompt: 'product turntable',
        duration: 15,
        extra: {
          aspect_ratio: '16:9',
          resolution: '720p',
        },
        input_reference: 'https://assets.example/product.png',
      });
      return Response.json({ id: 'snumom-task', status: 'queued' });
    });
    const result = await submitVideo({
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5（按次）',
      prompt: 'product turntable',
      duration: 15,
      aspectRatio: '16:9',
      resolution: '720p',
      referenceImages: ['https://assets.example/product.png'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'grok-video' });
  });

  it('submits MGRouter Grok video using the canonical catalog model id', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://raw.mgrouter.com/v1/videos/generations');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'grok-imagine-video-1.5', prompt: 'product turntable', duration: 6,
        aspect_ratio: '16:9', resolution: '480p',
      });
      return Response.json({ request_id: 'mgrouter-request' });
    });
    const result = await submitVideo({
      provider: 'mgrouter-grok-video', model: 'grok-video', prompt: 'product turntable', duration: 6,
      aspectRatio: '16:9', resolution: '480p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MGROUTER_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'mgrouter-grok-video' });
  });

  it('fails closed for MGRouter uploaded audio URLs', async () => {
    await expect(submitVideo({
      provider: 'mgrouter-grok-video', model: 'grok-imagine-video-1.5', prompt: 'speak', duration: 6,
      aspectRatio: '16:9', resolution: '480p', referenceAudios: ['https://assets.example/voice.wav'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MGROUTER_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('mgrouter_reference_audio_unsupported');
  });

  it('submits sd-mini through the same snumom supplier using seconds and image_urls', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://snumom.com/v1/videos');
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'sd-mini', prompt: 'cat jumps', seconds: '10', resolution: '720p', aspect_ratio: '16:9',
        image_urls: ['http://assets.example/a.jpg', 'https://assets.example/b.jpg'], mode: 'between_images',
      });
      return Response.json({ id: 'sd-mini-task', status: 'queued' });
    });
    const result = await submitVideo({
      provider: 'grok-video', model: 'sd-mini', prompt: ' cat jumps ', duration: 10,
      aspectRatio: '16:9', resolution: '720p', referenceImages: ['http://assets.example/a.jpg', 'https://assets.example/b.jpg'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'grok-video' });
  });

  it('rejects unsupported sd-mini reference media', async () => {
    await expect(submitVideo({
      provider: 'grok-video', model: 'sd-mini', prompt: 'demo', duration: 5,
      aspectRatio: '16:9', resolution: '480p', referenceAudios: ['https://assets.example/a.wav'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('sdmini_reference_media_unsupported');
  });

  it('fails closed for an unconfigured Grok supplier when live mode is enabled', async () => {
    await expect(submitVideo({
      provider: 'mgrouter-grok-video',
      model: 'grok-video',
      prompt: 'demo',
      duration: 6,
      aspectRatio: '16:9',
      resolution: '720p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('provider_not_configured');
  });

  it('normalizes common provider task response shapes', () => {
    expect(normalizeProviderResponse('grok-video', { id: 'abc', status: 'processing', progress: 42 })).toMatchObject({ providerTaskId: 'abc', status: 'running', progress: 42, outputUrls: [] });
    expect(normalizeProviderResponse('wan3-video', { data: { task_id: 'wan-1', state: 'succeeded', output: { url: 'https://cdn.example/video.mp4' } } })).toMatchObject({ providerTaskId: 'wan-1', status: 'completed', outputUrls: ['https://cdn.example/video.mp4'] });
    expect(normalizeProviderResponse('yuanai-image', { taskId: 'img-1', status: 'failed', error: { message: 'secret details' } })).toMatchObject({ providerTaskId: 'img-1', status: 'failed', error: 'provider request failed' });
    expect(normalizeProviderResponse('oairegbox-omni', { taskId: 'img-2', status: 'failed', error: { code: 'content_policy', message: 'This request did not pass content review' } })).toMatchObject({ error: 'provider_content_policy' });
    expect(normalizeProviderResponse('oairegbox-omni', { taskId: 'img-3', status: 'failed', error: { code: 'image_rejected', message: 'reference image rejected' } })).toMatchObject({ error: 'provider_reference_rejected' });
    expect(normalizeProviderResponse('grok-video', { taskId: 'vid-1', status: 'failed', error: { code: 'task_failed', message: 'upstream task failed' } })).toMatchObject({ error: 'provider_upstream_failed' });
    expect(normalizeProviderResponse('quality-v4', { taskId: 'vid-2', status: 'failed', error: '生成失败，积分已退还' })).toMatchObject({ error: 'provider_upstream_failed' });
    expect(normalizeProviderResponse('wan3-video', { id: 'task_x', status: 'succeeded', video_url: 'https://media.manjuai.top/videos/a.mp4', download_url: 'https://media.manjuai.top/downloads/a.mp4' })).toMatchObject({ providerTaskId: 'task_x', status: 'completed', progress: 100, outputUrls: ['https://media.manjuai.top/videos/a.mp4', 'https://media.manjuai.top/downloads/a.mp4'] });
    expect(normalizeProviderResponse('pomoai-gemini-image', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' } }] } }] })).toMatchObject({ status: 'completed', progress: 100 });
    expect(normalizeProviderResponse('yuanai-image', { data: [{ b64_json: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' }] })).toMatchObject({ status: 'completed', progress: 100 });
    expect(normalizeProviderResponse('grok-video', { id: 'grok-task', status: 'completed', url: 'https://cdn.example/video' })).toMatchObject({ providerTaskId: 'grok-task', status: 'completed', outputUrls: ['https://cdn.example/video'] });
    expect(normalizeProviderResponse('quality-v4', { id: 'quality-task', status: 'completed', url: 'http://video2.crack.cc.cd/media/v/quality-task' })).toMatchObject({ providerTaskId: 'quality-task', status: 'completed', outputUrls: ['https://video2.crack.cc.cd/media/v/quality-task'] });
    expect(normalizeProviderResponse('mgrouter-grok-video', { model: 'grok-imagine-video-1.5', progress: 100, status: 'done', video: { url: '/v1/videos/mg-task/content' } })).toMatchObject({ status: 'completed', progress: 100, outputUrls: ['https://raw.mgrouter.com/v1/videos/mg-task/content'] });
  });

  it('downloads snumom video content with bearer auth without exposing the token', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://snumom.com/v1/videos/task_123/content');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    const result = await downloadProviderVideoContent('grok-video', 'task_123', {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' },
      fetch: fetchMock as typeof fetch,
    });
    expect(result.mimeType).toBe('video/mp4');
    expect([...result.bytes]).toEqual([0, 0, 0, 24, 102, 116, 121, 112]);
  });

  it('downloads MGRouter video content through its authenticated endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://raw.mgrouter.com/v1/videos/mg-task/content');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    const result = await downloadProviderVideoContent('mgrouter-grok-video', 'mg-task', {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MGROUTER_API_KEY: 'test-key' },
      fetch: fetchMock as typeof fetch,
    });
    expect(result.mimeType).toBe('video/mp4');
  });
});
