import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { POMOAI_PROMPT_FALLBACK_MODELS } from './config';
import { normalizeGeminiResponse, normalizeGPTResponsesResponse, normalizeGrokVideoPrompt, normalizeProviderResponse, providerEndpoint, providerErrorInfo, providerResponseSnapshot, providerSubmissionTimeoutMs, sanitizeProviderError, validateReferenceUrls, generatePomoAIImage, generateSeedreamImage, generateYuanAIImage, generateGPTPrompt, generateBigSnakePrompt, generateGeminiPrompt, generateOpenAICompatibleImage, generateGeminiNativeImage, generateOriginNanoImage, submitVideo, submitVideoWithFallback, syncProviderTask, downloadProviderVideoContent, generateMGRouterImage, generateResponsesPrompt, generatePromptWithFallback } from './client';

describe('provider client helpers', () => {
  it('normalizes Gemini candidate text', () => {
    expect(normalizeGeminiResponse({ candidates: [{ content: { parts: [{ text: 'first' }, { text: 'second' }] } }] })).toBe('first\nsecond');
    expect(normalizeGeminiResponse({ candidates: [] })).toBe('');
  });

  it('normalizes Origin Nano markdown data images and exposes new endpoints', () => {
    const encoded = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=';
    expect(normalizeProviderResponse('origin-nano-image', { choices: [{ message: { content: `![image](data:image/jpeg;base64,${encoded})` } }] })).toMatchObject({ status: 'completed', outputBase64: [`data:image/jpeg;base64,${encoded}`] });
    expect(providerEndpoint('origin-gpt-image', 'create')).toBe('https://origingateway.com/v1/images/generations');
    expect(providerEndpoint('origin-nano-image', 'create')).toBe('https://origingateway.com/v1/chat/completions');
    expect(providerEndpoint('junze-gemini-image', 'create')).toContain('/v1beta/models/');
    expect(providerEndpoint('bigsnake-prompt', 'create')).toBe('https://api.bigsnake.xyz/v1/responses');
    expect(providerEndpoint('pomoai-gpt-prompt', 'create')).toBe('https://www.pomoai.ai/v1/responses');
    expect(providerEndpoint('oairegbox-gpt-prompt', 'create')).toBe('https://newapi-2.oairegbox.cc/v1/responses');
    expect(providerEndpoint('secure-skill-gpt-prompt', 'create')).toBe('https://token.secure-skill.com/v1/responses');
  });

  it('uses Junze GPT Image ratio-string requests on its OpenAI route', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'gpt-image-2', size: '9:16', quality: 'low', response_format: 'url' });
      return new Response(JSON.stringify({ data: [{ url: 'https://img2.junze.me/generated.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await generateOpenAICompatibleImage('junze-gpt-image', { model: 'gpt-image-2', prompt: 'cat', aspectRatio: '9:16', resolution: '1k' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', JUNZE_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes Aicloud GPT Image generation and local edits to its v1 endpoints', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toMatch(/^https:\/\/aiclound\.vip\/v1\/images\/(generations|edits)$/);
      if (init?.body instanceof FormData) {
        expect(String(url)).toBe('https://aiclound.vip/v1/images/edits');
        expect(init.body.get('model')).toBe('gpt-image-2.5');
        expect(init.body.get('size')).toBe('1024x1536');
      } else {
        expect(String(url)).toBe('https://aiclound.vip/v1/images/generations');
        expect(JSON.parse(String(init?.body))).toEqual({ model: 'gpt-image-2.5', prompt: 'cat', size: '1024x1536', n: 1 });
      }
      return Response.json({ data: [{ b64_json: 'data:image/png;base64,YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' }] });
    });
    await generateOpenAICompatibleImage('aicloud-gpt-image', { model: 'gpt-image-2.5', prompt: 'cat', aspectRatio: '9:16', resolution: '1k' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', AICLOUD_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    await generateOpenAICompatibleImage('aicloud-gpt-image', { model: 'gpt-image-2.5', prompt: 'edit', aspectRatio: '9:16', resolution: '1k', referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', AICLOUD_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('submits OriginGateway GPT Image reference edits as multipart for local files', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://origingateway.com/v1/images/edits');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
      expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
      const form = init?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('model')).toBe('gpt-image-2');
      expect(form.get('image')).toBeInstanceOf(File);
      expect(form.get('size')).toBe('2160x3840');
      return Response.json({ data: [{ url: 'https://img.example/edited.png' }] });
    });
    const result = await generateOpenAICompatibleImage('origin-gpt-image', {
      model: 'gpt-image-2', prompt: 'edit', aspectRatio: '9:16', resolution: '4k',
      referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', ORIGIN_GPTIMAGE_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits OriginGateway Grok reference edits as JSON URL input', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://origingateway.com/v1/images/edits');
      expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
        model: 'grok-imagine-image-2.0', image: 'https://assets.example/ref.png', response_format: 'url',
      }));
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('image_url');
      return Response.json({ data: [{ url: 'https://img.example/edited.png' }] });
    });
    const result = await generateOpenAICompatibleImage('origin-grok-image', {
      model: 'grok-imagine-image-2.0', prompt: 'edit', aspectRatio: '1:1', resolution: '1k',
      referenceImages: ['https://assets.example/ref.png'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', ORIGIN_GROK_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('rejects multipart OriginGateway Grok edits so callers use JSON bridge URLs', async () => {
    await expect(generateOpenAICompatibleImage('origin-grok-image', {
      model: 'grok-imagine-image-2.0', prompt: 'edit', aspectRatio: '1:1', resolution: '1k',
      referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', ORIGIN_GROK_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('origin_grok_reference_requires_json');
  });

  it('requires multipart local input for OriginGateway 4K reference edits', async () => {
    await expect(generateOpenAICompatibleImage('origin-gpt-image', {
      model: 'gpt-image-2', prompt: 'edit', aspectRatio: '9:16', resolution: '4k',
      referenceImages: ['https://assets.example/ref.png'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', ORIGIN_GPTIMAGE_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('origin_4k_reference_requires_multipart');
  });

  it('submits Origin Nano reference edits through Gemini inlineData', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://origingateway.com/v1beta/models/nano-banana-pro:generateContent');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
      expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBeUndefined();
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts).toEqual([
        { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
        { text: 'edit' },
      ]);
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] });
    });
    const result = await generateOriginNanoImage({
      model: 'nano-banana-pro', prompt: 'edit', aspectRatio: '1:1', resolution: '1k',
      references: [{ mimeType: 'image/png', dataBase64: 'YWJj' }],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', ORIGIN_NANO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('does not silently drop unsupported Origin Nano external references', async () => {
    await expect(generateOriginNanoImage({
      model: 'nano-banana-pro', prompt: 'edit', aspectRatio: '1:1',
      referenceImages: ['https://assets.example/ref.png'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', ORIGIN_NANO_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('origin_nano_external_reference_unsupported');
  });

  it('routes Origin Nano portrait requests through Gemini native generateContent', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://origingateway.com/v1beta/models/nano-banana-pro:generateContent');
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig).toEqual({ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await generateOriginNanoImage({ model: 'nano-banana-pro', prompt: 'cat', aspectRatio: '9:16', resolution: '1k' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', ORIGIN_NANO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls BigSnake Responses for child prompt generation', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-5.5', input: 'make a hook', max_output_tokens: 8000 });
      return new Response(JSON.stringify({ output_text: 'hook result' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await generateBigSnakePrompt({ model: 'gpt-5.5', prompt: 'make a hook' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', BIGSNAKE_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.text).toBe('hook result');
    expect(timeoutSpy).toHaveBeenCalledWith(5 * 60 * 1000);
    timeoutSpy.mockRestore();
  });

  it('calls PomoAI GPT Responses with the configured model and bearer key', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://www.pomoai.ai/v1/responses');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-5.5', input: [{ role: 'user' }] });
      return Response.json({ output_text: 'pomo result' });
    });
    const result = await generateResponsesPrompt('pomoai-gpt-prompt', { prompt: 'hello' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', POMOAI_GPT_PROMPT_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'pomoai-gpt-prompt', model: 'gpt-5.5', text: 'pomo result' });
    expect(timeoutSpy).toHaveBeenCalledWith(180 * 1000);
    timeoutSpy.mockRestore();
  });

  it('calls secure-skill GPT-5.5 Responses with medium reasoning', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://token.secure-skill.com/v1/responses');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        reasoning: { effort: 'medium' },
      });
      return Response.json({ status: 'completed', model: 'gpt-5.5', output_text: 'secure-skill result' });
    });
    const result = await generateResponsesPrompt('secure-skill-gpt-prompt', { prompt: 'hello' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SECURE_SKILL_GPT_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'secure-skill-gpt-prompt', model: 'gpt-5.5', text: 'secure-skill result' });
  });

  it('falls back only between PomoAI models', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://www.pomoai.ai/v1/responses');
      const body = JSON.parse(String(init?.body)) as { model?: string };
      if (body.model === 'gpt-5.5') return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 503 });
      if (body.model === 'gemini-3.8-flash') return Response.json({ output_text: 'pomo fallback result' });
      throw new Error(`unexpected PomoAI model ${body.model}`);
    });
    const result = await generatePromptWithFallback({ prompt: 'hello' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', POMOAI_GPT_PROMPT_API_KEY: 'pomo-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ provider: 'pomoai-gpt-prompt', model: 'gemini-3.8-flash', text: 'pomo fallback result', fallbackFrom: 'pomoai-gpt-prompt', fallbackProviders: ['pomoai-gpt-prompt'], fallbackModels: ['gpt-5.5'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the last blank live result instead of throwing when every PomoAI fallback model replies with empty text', async () => {
    const fetchMock = vi.fn(async () => Response.json({ output_text: '' }));
    const result = await generatePromptWithFallback({ prompt: 'hello' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', POMOAI_GPT_PROMPT_API_KEY: 'pomo-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'pomoai-gpt-prompt', text: '' });
    expect(fetchMock).toHaveBeenCalledTimes(POMOAI_PROMPT_FALLBACK_MODELS.length);
  });

  it('does not cross-fallback to OAIRegBox or BigSnake when all PomoAI models fail', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://www.pomoai.ai/v1/responses');
      return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 503 });
    });
    await expect(generatePromptWithFallback({ prompt: 'hello' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', POMOAI_GPT_PROMPT_API_KEY: 'pomo-key', OAIREGBOX_GPT_PROMPT_API_KEY: 'oai-key', BIGSNAKE_API_KEY: 'big-key' }, fetch: fetchMock as typeof fetch })).rejects.toMatchObject({
      promptProvider: 'pomoai-gpt-prompt',
      promptModel: POMOAI_PROMPT_FALLBACK_MODELS[POMOAI_PROMPT_FALLBACK_MODELS.length - 1],
      promptFallbackProviders: ['pomoai-gpt-prompt'],
      promptFallbackModels: [...POMOAI_PROMPT_FALLBACK_MODELS],
    });
    expect(fetchMock).toHaveBeenCalledTimes(POMOAI_PROMPT_FALLBACK_MODELS.length);
  });

  it('includes reference images in BigSnake child prompt requests', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input[0].content).toEqual([
        { type: 'input_text', text: 'identify the product' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
      ]);
      return Response.json({ output_text: 'image-aware prompt' });
    });
    const result = await generateBigSnakePrompt({ model: 'gpt-5.5', prompt: 'identify the product', attachments: [{ name: 'product.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', BIGSNAKE_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.text).toBe('image-aware prompt');
  });

  it('maps BigSnake network timeout to provider_408 with endpoint context', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchMock = vi.fn(async () => { throw timeout; });
    await expect(generateBigSnakePrompt({ model: 'gpt-5.5', prompt: 'slow prompt' }, {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', BIGSNAKE_API_KEY: 'test-key' },
      fetch: fetchMock as typeof fetch,
    })).rejects.toMatchObject({ name: 'ProviderRequestError', info: { code: 'provider_408', endpoint: 'https://api.bigsnake.xyz/v1/responses' } });
  });

  it('includes reference images in Gemini child prompt requests', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts).toEqual([
        { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } },
        { text: 'describe the product' },
      ]);
      return Response.json({ candidates: [{ content: { parts: [{ text: 'gemini prompt' }] } }] });
    });
    const result = await generateGeminiPrompt({ model: 'gemini-2.5-flash', prompt: 'describe the product', references: [{ name: 'product.jpg', mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' }] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GEMINI_PROMPT_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.text).toBe('gemini prompt');
  });

  it('rejects local or non-https reference URLs', () => {
    expect(validateReferenceUrls([])).toEqual([]);
    expect(() => validateReferenceUrls(['C:\\tmp\\image.jpg'])).toThrow(/https/);
    expect(() => validateReferenceUrls(['http://example.com/a.jpg'])).toThrow(/https/);
    expect(validateReferenceUrls(['https://assets.example/a.jpg'])).toEqual(['https://assets.example/a.jpg']);
  });

  it('uses fixed provider endpoints and redacts upstream errors', () => {
    expect(providerEndpoint('grok-video', 'create')).toBe('https://snumom.com/v1/videos');
    expect(providerEndpoint('yuanai-grok-video', 'create')).toBe('https://yuanai.uk/v1/videos');
    expect(providerEndpoint('yuanai-grok-video', 'status')).toBe('https://yuanai.uk/v1/videos/{id}');
    expect(providerEndpoint('yuanai-grok-video', 'content')).toBe('https://yuanai.uk/v1/videos/{id}/content');
    expect(providerEndpoint('mgrouter-grok-image', 'create')).toBe('https://raw.mgrouter.com/v1/images/generations');
    expect(providerEndpoint('mgrouter-grok-video', 'create')).toBe('https://raw.mgrouter.com/v1/videos/generations');
    expect(providerEndpoint('mgrouter-grok-video', 'status')).toBe('https://raw.mgrouter.com/v1/videos/{id}');
    expect(providerEndpoint('mgrouter-grok-video', 'content')).toBe('https://raw.mgrouter.com/v1/videos/{id}/content');
    expect(providerEndpoint('wan3-video', 'create')).toBe('https://api.manjuai.top/v1/videos/generations');
    expect(providerEndpoint('wan3-video', 'create', { WAN_BASE_URL: 'https://api.manjuai.top/v1' })).toBe('https://api.manjuai.top/v1/videos/generations');
    expect(providerEndpoint('wan-3-nsfw', 'create')).toBe('https://va.808relay.com/v1/videos');
    expect(providerEndpoint('wan-3-nsfw', 'status')).toBe('https://va.808relay.com/v1/videos/{id}');
    expect(providerEndpoint('wan-3-nsfw', 'content')).toBe('https://va.808relay.com/v1/videos/{id}/content');
    expect(providerEndpoint('seedream', 'create')).toBe('https://newapi.apiaw.com/v1/images/generations');
    expect(providerEndpoint('seedream', 'status')).toBe('https://newapi.apiaw.com/v1/images/generations');
    expect(providerEndpoint('apiaw-seedance-video', 'create')).toBe('https://newapi.apiaw.com/v1/videos');
    expect(providerEndpoint('apiaw-seedance-video', 'status')).toBe('https://newapi.apiaw.com/v1/videos/{id}');
    expect(providerEndpoint('apiaw-seedance-video', 'content')).toBe('https://newapi.apiaw.com/v1/videos/{id}/content');
    expect(providerEndpoint('pomoai-gemini-image', 'create')).toBe('https://www.pomoai.ai/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(providerEndpoint('gpt-2999-prompt', 'create')).toBe('https://2999api.com/v1/responses');
    expect(providerEndpoint('oairegbox-omni', 'create')).toBe('https://newapi-2.oairegbox.cc/v1/videos');
    expect(providerEndpoint('minimax-h3', 'create')).toBe('https://token.secure-skill.com/v1/videos');
    expect(providerEndpoint('minimax-h3', 'status')).toBe('https://token.secure-skill.com/v1/videos/{id}');
    expect(providerEndpoint('minimax-h3', 'content')).toBe('https://token.secure-skill.com/v1/videos/{id}/content');
    expect(providerEndpoint('pro666-video', 'create')).toBe('https://api.pro666.top/v1/videos');
    expect(providerEndpoint('pro666-video', 'status')).toBe('https://api.pro666.top/v1/videos/{id}');
    expect(sanitizeProviderError('Bearer secret-token: provider failed')).toBe('provider request failed');
  });

  it('submits 808relay Wan 3 with the documented wire model and fields', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://va.808relay.com/v1/videos');
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'wan-3', prompt: 'portrait', seconds: 5, resolution: '720p', aspect_ratio: '9:16' });
      return Response.json({ id: 'wan-relay-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'wan-3-nsfw', model: 'wan-3', prompt: 'portrait', duration: 5, aspectRatio: '9:16', resolution: '720p' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', WAN_3_NSFW_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'wan-3-nsfw' });
  });

  it('submits apiaw Seedance 2.0 Mini with the documented async video fields', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://newapi.apiaw.com/v1/videos');
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'seedance2.0-mini', prompt: 'portrait', seconds: '10', duration: 10,
        aspect_ratio: '9:16', ratio: '9:16', resolution: '720p',
        images: ['https://assets.example/a.png'], videos: [], audios: [], generate_audio: false, watermark: false,
      });
      return Response.json({ id: 'seedance-task', status: 'queued' });
    });
    const result = await submitVideo({
      provider: 'apiaw-seedance-video', model: 'seedance2.0-mini', prompt: 'portrait', duration: 10,
      aspectRatio: '9:16', resolution: '720p', referenceImages: ['https://assets.example/a.png'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SEEDREAM_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'apiaw-seedance-video' });
  });

  it('normalizes a supplier prompt byte-limit rejection to video_prompt_too_long', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'prompt_too_long', message: 'prompt 最长 4096 字节（UTF-8）' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    await expect(submitVideo({
      provider: 'apiaw-seedance-video', model: 'seedance2.0-mini', prompt: 'portrait', duration: 10,
      aspectRatio: '9:16', resolution: '720p', referenceImages: [],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SEEDREAM_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).rejects.toThrow('video_prompt_too_long');
  });

  it('requires Wan 3 reference audio to include a visual reference', async () => {
    await expect(submitVideo({
      provider: 'wan-3-nsfw', model: 'wan-3', prompt: 'portrait', duration: 5,
      aspectRatio: '9:16', resolution: '720p', referenceAudios: ['https://assets.example/a.wav'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', WAN_3_NSFW_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('wan_reference_audio_requires_visual');
  });

  it.each(['dola-seedream-5-0-pro-260628', 'dola-seedream-5-0-pro-260628-ep'])('submits Seedream with the current model even for a saved %s selection', async (model) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40, 1), Buffer.from([0xff, 0xd9])]).toString('base64');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://newapi.apiaw.com/v1/images/generations');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'dola-seedream-5-0-pro-260628', size: '936x1664', response_format: 'b64_json' });
      return Response.json({ data: [{ b64_json: jpeg }] });
    });
    const result = await generateSeedreamImage({ model, prompt: 'portrait', aspectRatio: '9:16', resolution: '1k' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', SEEDREAM_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    const normalized = normalizeProviderResponse('seedream', result.response);
    expect(normalized).toMatchObject({ status: 'completed', progress: 100, outputUrls: [] });
    expect(normalized.outputBase64[0]).toBe(jpeg);
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
    const snapshot = providerResponseSnapshot(caught);
    expect(snapshot.code).toBe('provider_content_policy');
    expect(snapshot.body).toEqual({ error: { code: 'content_policy', message: 'blocked by review' } });
  });

  it('labels accepted successful response snapshots without reporting provider request failure', () => {
    const body = { created: 1, data: [{ b64_json: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' }] };
    const snapshot = providerResponseSnapshot(undefined, { body, method: 'POST' });
    expect(snapshot).toMatchObject({
      code: 'provider_response_received',
      method: 'POST',
      body: { created: 1, data: [{ b64_json: { omitted: 'media_payload', characters: body.data[0].b64_json.length } }] },
    });
    expect(JSON.stringify(snapshot)).not.toContain(body.data[0].b64_json);
  });

  it('keeps explicit failed response snapshots marked as provider request failures', () => {
    expect(providerResponseSnapshot(undefined, { body: { status: 'failed', error: { message: 'blocked' } }, method: 'POST' })).toMatchObject({
      code: 'provider_request_failed',
      method: 'POST',
      body: { status: 'failed', error: { message: 'blocked' } },
    });
  });

  it('summarizes oversized media in successful response snapshots without retaining its Base64', () => {
    const body = { created: 1, data: [{ b64_json: 'a'.repeat(1024 * 1024 + 64) }] };
    const snapshot = providerResponseSnapshot(undefined, { body, method: 'POST' });
    expect(snapshot).toMatchObject({
      code: 'provider_response_received',
      method: 'POST',
      body: { data: [{ b64_json: { omitted: 'media_payload', characters: body.data[0].b64_json.length, sha256: expect.any(String) } }] },
    });
    expect(snapshot).not.toHaveProperty('truncated');
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThan(2048);
  });

  it('summarizes media payloads nested in arrays and inline-data envelopes', () => {
    const encoded = 'YWJjZGVm';
    const snapshot = providerResponseSnapshot(undefined, {
      body: {
        outputBase64: [encoded],
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: encoded } }] } }],
      },
    });
    expect(snapshot).toMatchObject({
      body: {
        outputBase64: [{ omitted: 'media_payload', characters: encoded.length }],
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: { omitted: 'media_payload', characters: encoded.length } } }] } }],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(encoded);
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
      expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '9:16', imageSize: '1K' });
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] });
    });
    const result = await generatePomoAIImage({ model: 'gemini-3.1-flash-image', prompt: 'draw', references: [], aspectRatio: '9:16', resolution: '1k' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', POMOAI_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
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

  it('reduces oversized YuanAI references before the synchronous edit request', async () => {
    const pixels = Buffer.allocUnsafe(2160 * 3840 * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = index % 251;
    const original = await sharp(pixels, { raw: { width: 2160, height: 3840, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(original.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const file = (init?.body as FormData).get('image') as File;
      const optimized = Buffer.from(await file.arrayBuffer());
      expect(file.type).toBe('image/jpeg');
      expect(file.name).toBe('large.jpg');
      expect(optimized.byteLength).toBeLessThan(original.byteLength);
      const metadata = await sharp(optimized).metadata();
      expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(2048);
      return Response.json({ data: [{ b64_json: 'YWJj' }] });
    });
    await generateYuanAIImage({
      model: 'gpt-image-2', prompt: 'edit', aspectRatio: '9:16', resolution: '4k',
      referenceFiles: [{ bytes: new Uint8Array(original), mimeType: 'image/png', fileName: 'large.png' }],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        max_output_tokens: 8000,
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
    })).toEqual({ text: 'first\nsecond', incompleteReason: undefined });
    expect(normalizeGPTResponsesResponse({ choices: [{ message: { content: [{ text: 'fallback' }] } }] })).toEqual({ text: 'fallback', incompleteReason: undefined });
    expect(normalizeGPTResponsesResponse({})).toEqual({ text: '', incompleteReason: undefined });
  });

  it('reports the incomplete_details reason when reasoning consumes the entire output-token budget', () => {
    expect(normalizeGPTResponsesResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', content: [] }],
    })).toEqual({ text: '', incompleteReason: 'max_output_tokens' });
    expect(normalizeGPTResponsesResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'partial but present',
    })).toEqual({ text: 'partial but present', incompleteReason: 'max_output_tokens' });
    expect(normalizeGPTResponsesResponse({ status: 'incomplete', incomplete_details: {} })).toEqual({ text: '', incompleteReason: 'incomplete' });
  });

  it('submits one OAIRegBox reference URL as an explicit first frame', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).not.toBeInstanceOf(FormData);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'omni-fast-no-water', prompt: 'demo', seconds: '10', aspect_ratio: '9:16', first_image_url: 'https://assets.example/a.png',
      });
      return Response.json({ id: 'omni-first-frame-task', status: 'queued' });
    });
    await expect(submitVideo({
      provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10,
      aspectRatio: '9:16', resolution: '720p', referenceImages: ['https://assets.example/a.png'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).resolves.toMatchObject({ mode: 'live' });
  });

  it('submits OAIRegBox JSON when no references are provided', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'omni-fast-no-water', prompt: 'demo', seconds: '10', aspect_ratio: '16:9' });
      return Response.json({ id: 'omni-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720p' }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('uses a longer timeout for OAIRegBox video acceptance', () => {
    expect(providerSubmissionTimeoutMs('oairegbox-omni')).toBe(120_000);
    expect(providerSubmissionTimeoutMs('grok-video')).toBe(25_000);
  });

  it.each([
    ['JSON', undefined],
    ['multipart', [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }]],
  ] as const)('retains OAIRegBox %s submission timeout diagnostics', async (_kind, referenceFiles) => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchMock = vi.fn(async () => { throw timeout; });
    let caught: unknown;
    try {
      await submitVideo({
        provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10,
        aspectRatio: '16:9', resolution: '720p', ...(referenceFiles ? { referenceFiles: [...referenceFiles] } : {}),
      }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    } catch (error) { caught = error; }
    expect(providerResponseSnapshot(caught)).toMatchObject({
      code: 'provider_408',
      endpoint: 'https://newapi-2.oairegbox.cc/v1/videos',
      method: 'POST',
      stage: 'video_submission',
      timeoutMs: 120_000,
      reason: 'TimeoutError',
    });
  });

  it('submits MiniMax H3 requests through the secure-skill gateway', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://token.secure-skill.com/v1/videos');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'minimax-h3', prompt: 'demo', ratio: '16:9', resolution: '720p', duration: 10,
        image_urls: ['https://assets.example/a.png'],
      });
      return Response.json({ id: 'minimax-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'minimax-h3', model: 'minimax-h3', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720p', referenceImages: ['https://assets.example/a.png'] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MINIMAX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'minimax-h3' });
  });

  it('rejects reference videos for MiniMax H3', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return Response.json({ id: 'minimax-task', status: 'queued' });
    });
    await expect(submitVideo({
      provider: 'minimax-h3', model: 'minimax-h3', prompt: 'demo', duration: 10,
      aspectRatio: '16:9', resolution: '720p',
      referenceImages: ['https://assets.example/a.png'],
      referenceVideos: ['https://assets.example/a.mp4'],
      referenceAudios: ['https://assets.example/a.mp3'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MINIMAX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).rejects.toThrow('minimax_reference_media_unsupported');
  });

  it('submits Pro666 sd2-933-mini with fixed 12s portrait fields', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.pro666.top/v1/videos');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'sd2-933-mini', prompt: 'demo', duration: 12, resolution: '720p', aspect_ratio: '9:16', generateAudio: true,
        images: ['https://assets.example/a.png'], audios: ['https://assets.example/a.mp3'],
      });
      return Response.json({ task_id: 'pro-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'pro666-video', model: 'sd2-933-mini', prompt: 'demo', duration: 12, aspectRatio: '9:16', resolution: '720p', referenceImages: ['https://assets.example/a.png'], referenceAudios: ['https://assets.example/a.mp3'] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', PRO666_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'pro666-video' });
  });

  it('rejects Pro666 reference videos', async () => {
    await expect(submitVideo({ provider: 'pro666-video', model: 'sd2-933-mini', prompt: 'demo', duration: 12, aspectRatio: '9:16', resolution: '720p', referenceVideos: ['https://assets.example/a.mp4'] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', PRO666_VIDEO_API_KEY: 'test-key' }, fetch: vi.fn() as typeof fetch })).rejects.toThrow('pro666_reference_video_unsupported');
  });

  it('submits one OAIRegBox local file as a first-frame data URI', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).not.toBeInstanceOf(FormData);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'omni-fast-no-water', prompt: 'demo', seconds: '10', aspect_ratio: '16:9', first_image_url: 'data:image/png;base64,iVBORw==',
      });
      return Response.json({ id: 'omni-first-frame-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720p', referenceFiles: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result.mode).toBe('live');
  });

  it('keeps multiple OAIRegBox images in multipart reference mode', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).getAll('input_reference[]')).toHaveLength(2);
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
      expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
      return Response.json({ id: 'omni-task', status: 'queued' });
    });
    const result = await submitVideo({ provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9', resolution: '720p', referenceFiles: [
      { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'first.png' },
      { bytes: new Uint8Array([137, 80, 78, 72]), mimeType: 'image/png', fileName: 'second.png' },
    ] }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', OAIREGBOX_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
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

  it('accepts a Snumom Grok prompt containing exactly 4096 UTF-8 bytes', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'snumom-limit-task', status: 'queued' }));
    await expect(submitVideo({
      provider: 'grok-video', model: 'grok-imagine-video-1.5（按次）', prompt: 'a'.repeat(4096), duration: 6,
      aspectRatio: '9:16', resolution: '720p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).resolves.toMatchObject({ mode: 'live' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('normalizes typographic punctuation before validating and submitting Grok video prompts', async () => {
    const original = '【Reference】 scene’s movement – smooth — “stable”';
    const normalized = '[Reference] scene\'s movement - smooth - "stable"';
    expect(normalizeGrokVideoPrompt(original)).toBe(normalized);
    expect(Buffer.byteLength(normalized, 'utf8')).toBeLessThan(Buffer.byteLength(original, 'utf8'));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).prompt).toBe(normalized);
      return Response.json({ id: 'snumom-normalized-task', status: 'queued' });
    });
    await expect(submitVideo({
      provider: 'grok-video', model: 'grok-imagine-video-1.5', prompt: original, duration: 6,
      aspectRatio: '9:16', resolution: '720p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).resolves.toMatchObject({ mode: 'live' });
  });

  it('accepts a Grok prompt that fits 4096 UTF-8 bytes after punctuation normalization', async () => {
    const prompt = `${'a'.repeat(4094)}【】`;
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(4100);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(Buffer.byteLength(JSON.parse(String(init?.body)).prompt, 'utf8')).toBe(4096);
      return Response.json({ id: 'snumom-normalized-limit-task', status: 'queued' });
    });
    await expect(submitVideo({
      provider: 'grok-video', model: 'grok-imagine-video-1.5', prompt, duration: 6,
      aspectRatio: '9:16', resolution: '720p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).resolves.toMatchObject({ mode: 'live' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a Snumom Grok prompt over 4096 UTF-8 bytes before fetch', async () => {
    const fetchMock = vi.fn();
    await expect(submitVideo({
      provider: 'grok-video', model: 'grok-imagine-video-1.5（按次）', prompt: 'a'.repeat(4097), duration: 6,
      aspectRatio: '9:16', resolution: '720p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).rejects.toThrow('video_prompt_too_long');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts multibyte Chinese text using UTF-8 bytes for the Snumom Grok limit', async () => {
    const fetchMock = vi.fn();
    expect('中'.repeat(1366)).toHaveLength(1366);
    expect(Buffer.byteLength('中'.repeat(1366), 'utf8')).toBe(4098);
    await expect(submitVideo({
      provider: 'grok-video', model: 'grok-imagine-video-1.5（按次）', prompt: '中'.repeat(1366), duration: 6,
      aspectRatio: '9:16', resolution: '720p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch })).rejects.toThrow('video_prompt_too_long');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits MGRouter Grok video using the canonical catalog model id', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://raw.mgrouter.com/v1/videos/generations');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'grok-imagine-video-1.5', prompt: '[product] "turntable"', duration: 6,
        aspect_ratio: '16:9', resolution: '480p',
      });
      return Response.json({ request_id: 'mgrouter-request' });
    });
    const result = await submitVideo({
      provider: 'mgrouter-grok-video', model: 'grok-video', prompt: '\u3010product\u3011 \u201cturntable\u201d', duration: 6,
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

  it('submits YuanAI Grok video with Qingfeng fields', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://yuanai.uk/v1/videos');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'grok-imagine-video-1.5-preview', prompt: 'portrait-product', seconds: '6', aspect_ratio: '9:16', resolution: '720p', input_reference: 'https://assets.example/product.jpg',
      });
      return Response.json({ id: 'task_yuanai', task_id: 'task_yuanai', status: 'queued' });
    });
    const result = await submitVideo({
      provider: 'yuanai-grok-video', model: 'grok-imagine-video-1.5-preview', prompt: 'portrait\u2013product', duration: 6,
      aspectRatio: '9:16', resolution: '720p', referenceImages: ['https://assets.example/product.jpg'],
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ mode: 'live', provider: 'yuanai-grok-video' });
  });

  it('keeps YuanAI creation task id when status response returns a different id', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://yuanai.uk/v1/videos/task_created');
      return Response.json({ id: 'video_transient', task_id: 'video_transient', status: 'processing', progress: 40 });
    });
    const result = await syncProviderTask('yuanai-grok-video', 'task_created', {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_GROK_VIDEO_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch,
    });
    expect(result.providerTaskId).toBe('task_created');
    expect(result.status).toBe('running');
  });

  it('treats an accepted MGRouter xAI HTTP 400 status as terminal upstream failure', async () => {
    const body = { error: { message: 'xAI upstream returned status 400', type: 'invalid_request_error' } };
    const fetchMock = vi.fn(async () => Response.json(body, { status: 400 }));
    const result = await syncProviderTask('mgrouter-grok-video', 'accepted-mg-task', {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MGROUTER_API_KEY: 'test-key' }, fetch: fetchMock as typeof fetch,
    });
    expect(result).toMatchObject({
      providerTaskId: 'accepted-mg-task', status: 'failed', progress: 100,
      error: 'provider_upstream_failed', response: body,
    });
  });

  it('never switches a Grok video request to a sibling supplier after upstream failure', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://yuanai.uk/v1/videos');
      return new Response(JSON.stringify({ error: { code: 'upstream_task_failed' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    });
    await expect(submitVideoWithFallback({
      provider: 'yuanai-grok-video', model: 'grok-imagine-video-1.5-preview', prompt: 'demo', duration: 6, aspectRatio: '9:16', resolution: '480p',
    }, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_GROK_VIDEO_API_KEY: 'yuan-key', MGROUTER_API_KEY: 'mg-key' }, fetch: fetchMock as typeof fetch })).rejects.toThrow('provider_upstream_failed');
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it('does not fail over an ambiguous timeout or accepted task in durable mode', async () => {
    const env = { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', YUANAI_GROK_VIDEO_API_KEY: 'test-yuan', MGROUTER_API_KEY: 'test-mg' };
    const input = { provider: 'yuanai-grok-video' as const, model: 'grok-imagine-video-1.5-preview', prompt: 'demo', duration: 6, aspectRatio: '9:16', resolution: '720p' };
    const timeout = vi.fn(async () => { throw new Error('provider_504'); });
    await expect(submitVideoWithFallback(input, { env, fetch: timeout as typeof fetch, preventAmbiguousResubmission: true })).rejects.toThrow();
    expect(timeout).toHaveBeenCalledTimes(1);
    const accepted = vi.fn(async () => Response.json({ id: 'preserve-upstream-id', status: 'failed', error: 'provider_upstream_failed' }));
    const result = await submitVideoWithFallback(input, { env, fetch: accepted as typeof fetch, preventAmbiguousResubmission: true });
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(normalizeProviderResponse(result.provider, result.response).providerTaskId).toBe('preserve-upstream-id');
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
    expect(normalizeProviderResponse('pro666-video', { task_id: 'vid-3', status: 'failed', error: { code: 'service_error', message: 'video_urls is not enabled' } })).toMatchObject({ error: 'pro666_reference_video_unsupported' });
    expect(normalizeProviderResponse('wan3-video', { id: 'task_x', status: 'succeeded', video_url: 'https://media.manjuai.top/videos/a.mp4', download_url: 'https://media.manjuai.top/downloads/a.mp4' })).toMatchObject({ providerTaskId: 'task_x', status: 'completed', progress: 100, outputUrls: ['https://media.manjuai.top/videos/a.mp4'] });
    expect(normalizeProviderResponse('pomoai-gemini-image', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' } }] } }] })).toMatchObject({ status: 'completed', progress: 100 });
    expect(normalizeProviderResponse('yuanai-image', { data: [{ b64_json: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' }] })).toMatchObject({ status: 'completed', progress: 100 });
    expect(normalizeProviderResponse('grok-video', { id: 'grok-task', status: 'completed', url: 'https://cdn.example/video' })).toMatchObject({ providerTaskId: 'grok-task', status: 'completed', outputUrls: ['https://cdn.example/video'] });
    expect(normalizeProviderResponse('quality-v4', { id: 'quality-task', status: 'completed', url: 'http://video2.crack.cc.cd/media/v/quality-task' })).toMatchObject({ providerTaskId: 'quality-task', status: 'completed', outputUrls: ['https://video2.crack.cc.cd/media/v/quality-task'] });
    expect(normalizeProviderResponse('mgrouter-grok-video', { model: 'grok-imagine-video-1.5', progress: 100, status: 'done', video: { url: '/v1/videos/mg-task/content' } })).toMatchObject({ status: 'completed', progress: 100, outputUrls: ['https://raw.mgrouter.com/v1/videos/mg-task/content'] });
    expect(normalizeProviderResponse('pro666-video', { task_id: 'pro-task', status: 'completed', output: [{ url: 'https://video.pro666.top/generated/pro.mp4' }] })).toMatchObject({ providerTaskId: 'pro-task', status: 'completed', outputUrls: ['https://video.pro666.top/generated/pro.mp4'] });
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

  it('downloads MiniMax H3 content through secure-skill', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://token.secure-skill.com/v1/videos/h3-task/content');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    const result = await downloadProviderVideoContent('minimax-h3', 'h3-task', {
      env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', MINIMAX_API_KEY: 'test-key' },
      fetch: fetchMock as typeof fetch,
    });
    expect(result.mimeType).toBe('video/mp4');
  });
});
