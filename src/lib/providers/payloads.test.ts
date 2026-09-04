import { describe, expect, it } from 'vitest';
import { buildGrokVideoPayload, buildSdMiniVideoPayload, buildMGRouterImagePayload, buildMGRouterVideoPayload, buildWanVideoPayload, buildMiniMaxVideoPayload, buildPro666VideoPayload, normalizeAudioPlaceholders, providerKind, buildPomoAIImagePayload, buildYuanAIImageEditFormData, buildYuanAIImagePayload, yuanAIImageSize, buildGPTPromptPayload, buildGPTResponsesPayload, buildOAIRegboxPayload, buildOAIRegboxMultipartFormData, buildOpenAIImagePayload, buildOpenAIImageEditPayload, buildOpenAIImageEditFormData, buildGeminiNativeImagePayload, buildOriginNanoChatPayload } from './payloads';

describe('provider payload contracts', () => {
  it('uses documented Origin/Junze image contracts and preserves portrait ratios', () => {
    expect(buildOpenAIImagePayload({ model: 'gpt-image-2', prompt: 'cat', aspectRatio: '9:16', resolution: '4k' })).toMatchObject({ model: 'gpt-image-2', size: '1152x2048', quality: 'high', response_format: 'url' });
    expect(buildOpenAIImagePayload({ model: 'grok-imagine-image-2.0', prompt: 'cat', aspectRatio: '9:16', resolution: '1k' })).toMatchObject({ size: '9:16', quality: 'medium' });
    expect(buildOriginNanoChatPayload('nano-banana-pro', 'cat')).toEqual({ model: 'nano-banana-pro', messages: [{ role: 'user', content: 'cat' }], max_tokens: 64 });
    expect(buildGeminiNativeImagePayload({ model: 'gemini-3-pro-image-preview', prompt: 'cat', aspectRatio: '9:16', resolution: '1k' })).toMatchObject({ generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16', imageSize: '1K' } } });
  });

  it('builds OriginGateway reference-image JSON edits with image/images, never image_url', () => {
    expect(buildOpenAIImageEditPayload({ model: 'gpt-image-2', prompt: 'edit', referenceImages: ['https://assets.example/a.png'], aspectRatio: '1:1', resolution: '1k' })).toEqual(expect.objectContaining({
      model: 'gpt-image-2', prompt: 'edit', image: 'https://assets.example/a.png', size: '1024x1024', response_format: 'url',
    }));
    expect(buildOpenAIImageEditPayload({ model: 'gpt-image-2', prompt: 'merge', referenceImages: ['https://assets.example/a.png', 'https://assets.example/b.png'] })).toEqual(expect.objectContaining({
      images: ['https://assets.example/a.png', 'https://assets.example/b.png'],
    }));
    expect(buildOpenAIImageEditPayload({ model: 'gpt-image-2', prompt: 'edit', referenceImages: ['https://assets.example/a.png'] })).not.toHaveProperty('image_url');
  });

  it('builds OriginGateway multipart edits with image and image[] fields', () => {
    const single = buildOpenAIImageEditFormData({
      model: 'gpt-image-2', prompt: 'edit', referenceFiles: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', fileName: 'a.png' }],
      aspectRatio: '16:9', resolution: '4k',
    });
    expect(single.get('image')).toBeInstanceOf(File);
    expect(single.get('image[]')).toBeNull();
    expect(single.get('size')).toBe('3840x2160');
    const multiple = buildOpenAIImageEditFormData({
      model: 'gpt-image-2', prompt: 'merge', referenceFiles: [
        { bytes: new Uint8Array([1]), mimeType: 'image/png', fileName: 'a.png' },
        { bytes: new Uint8Array([2]), mimeType: 'image/jpeg', fileName: 'b.jpg' },
      ],
    });
    expect(multiple.getAll('image[]')).toHaveLength(2);
    expect(multiple.get('image')).toBeNull();
  });
  it('builds native Grok payloads with the historical reference image split', () => {
    expect(buildGrokVideoPayload({ model: 'grok-imagine-video-1.5（按次）', prompt: 'demo', duration: 10, aspectRatio: '9:16', resolution: '720p', referenceImages: [] })).toEqual({ model: 'grok-imagine-video-1.5（按次）', prompt: 'demo', duration: 10, extra: { aspect_ratio: '9:16', resolution: '720p' } });
    expect(buildGrokVideoPayload({ model: 'grok-imagine-video-1.5（按次）', prompt: 'demo', duration: 10, aspectRatio: '9:16', resolution: '720p', referenceImages: ['https://assets.example/a.jpg'] })).toHaveProperty('input_reference', 'https://assets.example/a.jpg');
    expect(buildGrokVideoPayload({ model: 'grok-imagine-video-1.5（按次）', prompt: 'demo', duration: 10, aspectRatio: '9:16', resolution: '720p', referenceImages: ['https://assets.example/a.jpg', 'https://assets.example/b.jpg'] })).toEqual(expect.objectContaining({ extra: expect.objectContaining({ reference_images: [{ url: 'https://assets.example/a.jpg', role: 'reference_image' }, { url: 'https://assets.example/b.jpg', role: 'reference_image' }] }) }));
  });

  it('builds the sd-mini payload with top-level fields and image modes', () => {
    expect(buildSdMiniVideoPayload({ model: 'sd-mini', prompt: '  cat jumps  ', seconds: 10 })).toEqual({
      model: 'sd-mini', prompt: 'cat jumps', seconds: '10', resolution: '720p', aspect_ratio: '9:16',
    });
    expect(buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', duration: 10 })).toEqual(expect.objectContaining({ seconds: '10', resolution: '720p' }));
    expect(buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 10, resolution: '720p', aspectRatio: '9:16', referenceImages: ['https://assets.example/a.jpg'] })).toEqual({
      model: 'sd-mini', prompt: 'cat jumps', seconds: '10', resolution: '720p', aspect_ratio: '9:16', image_urls: ['https://assets.example/a.jpg'], mode: 'start_image',
    });
    expect(buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 10, referenceImages: ['http://assets.example/a.jpg', 'https://assets.example/b.jpg'] })).toEqual(expect.objectContaining({ seconds: '10', mode: 'between_images', image_urls: ['http://assets.example/a.jpg', 'https://assets.example/b.jpg'] }));
    expect(buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 10, referenceImages: ['https://assets.example/a.jpg', 'https://assets.example/b.jpg', 'https://assets.example/c.jpg'] })).toEqual(expect.objectContaining({ seconds: '10', mode: 'reference_images' }));
    expect(buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 5 })).toEqual(expect.objectContaining({ seconds: '5', resolution: '480p' }));
    expect(buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 15, resolution: '480p' })).toEqual(expect.objectContaining({ seconds: '15', resolution: '480p' }));
    expect(() => buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 5, resolution: '720p' })).toThrow('sdmini_720p_requires_10s');
    expect(() => buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 10, resolution: '1080p' })).toThrow('sdmini_invalid_resolution');
    expect(() => buildSdMiniVideoPayload({ model: 'sd-mini', prompt: 'cat jumps', seconds: 10, referenceImages: Array.from({ length: 8 }, (_, i) => `https://assets.example/${i}.jpg`) })).toThrow('sdmini_too_many_reference_images');
  });

  it('normalizes MGRouter audio placeholders without duplicating them', () => {
    expect(normalizeAudioPlaceholders('show product')).toBe('show product');
    expect(normalizeAudioPlaceholders('show product', 1)).toBe('show product <AUDIO_0>');
    expect(normalizeAudioPlaceholders('show <AUDIO_0>', 2)).toBe('show <AUDIO_0> <AUDIO_1>');
  });

  it('builds the Pro666 sd2-933-mini payload', () => {
    expect(buildPro666VideoPayload({ prompt: ' demo ', images: ['https://assets.example/a.jpg'], audios: ['https://assets.example/a.mp3'] })).toEqual({
      model: 'sd2-933-mini', prompt: 'demo', duration: 12, resolution: '720p', aspect_ratio: '9:16', generateAudio: true,
      images: ['https://assets.example/a.jpg'], audios: ['https://assets.example/a.mp3'],
    });
  });

  it('builds MGRouter and Wan multi-media payloads', () => {
    expect(buildMGRouterImagePayload({ model: 'grok-imagine-image-quality', prompt: 'demo', aspectRatio: '9:16', resolution: '2k', referenceImages: ['https://assets.example/a.jpg'] })).toEqual({ model: 'grok-imagine-image-quality', prompt: 'demo', aspect_ratio: '9:16', resolution: '2k', images: [{ url: 'https://assets.example/a.jpg' }] });
    expect(buildMGRouterVideoPayload({ model: 'grok-video', prompt: 'demo', aspectRatio: '16:9', resolution: '720p', duration: 8, referenceImages: [], referenceAudios: ['https://assets.example/eve.wav'] })).toEqual(expect.objectContaining({ model: 'grok-imagine-video-1.5', aspect_ratio: '16:9', resolution: '720p', duration: 8, reference_audios: [{ url: 'https://assets.example/eve.wav' }] }));
    expect(buildWanVideoPayload({ model: 'wan3.0-prime-r2v', prompt: 'demo', ratio: '16:9', resolution: '480p', duration: 8, media: [{ type: 'reference_image', url: 'https://assets.example/a.jpg' }, { type: 'audio', url: 'https://assets.example/a.wav' }] })).toEqual(expect.objectContaining({ model: 'wan3.0-prime-r2v', ratio: '16:9', resolution: '480P', duration: 8, media: expect.any(Array) }));
    expect(buildWanVideoPayload({ model: 'wan3.0-prime-t2v', prompt: 'demo', ratio: '16:9', resolution: '480p', duration: 5, media: [] })).not.toHaveProperty('media');
  });

  it('builds the MiniMax H3 secure-skill payload', () => {
    expect(buildMiniMaxVideoPayload({ model: 'minimax-h3', prompt: ' demo ', duration: 10, aspectRatio: '16:9', resolution: '720p', referenceImages: ['https://assets.example/a.png'], referenceAudios: ['https://assets.example/a.mp3'] })).toEqual({
      model: 'minimax-h3', prompt: 'demo', ratio: '16:9', resolution: '720p', duration: 10,
      image_urls: ['https://assets.example/a.png'], audio_urls: ['https://assets.example/a.mp3'],
    });
  });

  it('keeps provider kinds aligned with production modes', () => {
    expect(providerKind('yuanai-image')).toBe('image');
    expect(providerKind('yuanai-gemini-prompt')).toBe('prompt');
    expect(providerKind('wan3-video')).toBe('video');
  });

  it('builds the historical PomoAI Gemini image request envelope', () => {
    const payload = buildPomoAIImagePayload({
      model: 'gemini-3.1-flash-image',
      prompt: 'product hero',
      references: [{ mimeType: 'image/jpeg', dataBase64: 'YWJj' }],
    });
    expect(payload).toEqual({ contents: [{ parts: [
      { inlineData: { mimeType: 'image/jpeg', data: 'YWJj' } },
      { text: 'product hero' },
    ] }] });
  });

  it('passes the image ratio and size shown by the PomoAI form', () => {
    const payload = buildPomoAIImagePayload({ model: 'gemini-3.1-flash-image', prompt: 'portrait', aspectRatio: '9:16', resolution: '1k' });
    expect(payload).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: '9:16', imageSize: '1K' } } });
  });

  it('builds YuanAI gpt-image-2 multipart edit fields', () => {
    const form = buildYuanAIImageEditFormData({
      model: 'gpt-image-2', prompt: 'edit', size: '1536x1024', quality: 'low',
      references: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', fileName: 'ref.png' }],
    });
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('prompt')).toBe('edit');
    expect(form.get('size')).toBe('1536x1024');
    expect(form.get('response_format')).toBe('b64_json');
    expect(form.get('quality')).toBeNull();
    expect(form.get('image')).toBeInstanceOf(File);
  });

  it('preserves YuanAI 4k resolution in the ordinary image-generation payload', () => {
    expect(buildYuanAIImagePayload({
      model: 'gpt-image-2',
      prompt: 'ultra detailed product hero',
      aspectRatio: '1:1',
      resolution: '4k' as never,
      referenceImages: [],
    })).toEqual({
      model: 'gpt-image-2',
      prompt: 'ultra detailed product hero',
      aspect_ratio: '1:1',
      resolution: '4k',
      size: '2048x2048',
    });
  });

  it('maps YuanAI image ratios to non-square canvases', () => {
    expect(yuanAIImageSize('9:16', '1k')).toBe('1024x1536');
    expect(yuanAIImageSize('16:9', '2k')).toBe('3072x2048');
    expect(yuanAIImageSize('9:16', '4k')).toBe('2160x3840');
    expect(buildYuanAIImagePayload({ model: 'gpt-image-2', prompt: 'portrait', aspectRatio: '9:16', resolution: '4k', referenceImages: [] })).toEqual(expect.objectContaining({ aspect_ratio: '9:16', resolution: '4k', size: '2160x3840' }));
  });

  it('builds GPT-2999 chat-completions payloads', () => {
    expect(buildGPTPromptPayload('gpt-5.5', [{ role: 'user', content: 'hello' }])).toEqual({
      model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('builds GPT-2999 Responses API payloads with input_text content blocks', () => {
    expect(buildGPTResponsesPayload('gpt-5.5', [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'hello' },
    ])).toEqual({
      model: 'gpt-5.5',
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'You are concise.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      max_output_tokens: 2800,
    });
  });

  it('attaches Responses API image and text references to the final user turn', () => {
    const payload = buildGPTResponsesPayload('gpt-5.5', [
      { role: 'user', content: 'describe' },
      { role: 'assistant', content: 'ready' },
      { role: 'user', content: 'use this' },
    ], [{ name: 'ref.png', mimeType: 'image/png', dataBase64: 'YWJj' }, { name: 'notes.txt', mimeType: 'text/plain', text: 'notes' }]);
    expect(payload.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'describe' }] },
      { role: 'assistant', content: [{ type: 'input_text', text: 'ready' }] },
      { role: 'user', content: [
        { type: 'input_text', text: 'use this' },
        { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
        { type: 'input_text', text: '[参考文件：notes.txt]\nnotes' },
      ] },
    ]);
  });

  it('builds OAIRegBox Omni JSON and multipart contracts', () => {
    expect(buildOAIRegboxPayload({ model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9', references: [] })).toEqual({
      model: 'omni-fast-no-water', prompt: 'demo', seconds: '10', aspect_ratio: '16:9',
    });
    const form = buildOAIRegboxMultipartFormData({
      model: 'omni-fast-no-water', prompt: 'demo', duration: 10, aspectRatio: '16:9',
      references: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', fileName: 'ref.png' }],
    });
    expect(form.get('input_reference[]')).toBeInstanceOf(File);
    expect(form.get('seconds')).toBe('10');
  });
});
