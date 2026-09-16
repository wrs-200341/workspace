import { describe, expect, it, vi } from 'vitest';
import { buildDolaSd2VideoPayload } from './payloads';
import { normalizeProviderResponse, providerEndpoint, submitVideo, syncProviderTask, type SubmitVideoInput } from './client';

const env = { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true', DOLA_SD2_API_KEY: 'test-key' };
const reference = { fileName: 'portrait.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) };
const input: SubmitVideoInput = { provider: 'dola-sd2', model: 'dola-sd2', prompt: 'portrait', duration: 5, aspectRatio: '9:16', resolution: '720p', requestId: 'workspace-task-1', referenceFiles: [reference] };
const signedUrl = 'https://v16-dola.dola.com/signature/video/tos/generated/?mime_type=video_mp4&token=example';

describe('dola sd2 supplier contract', () => {
  it('uses generations and tasks endpoints without an invented content route', () => {
    expect(providerEndpoint('dola-sd2', 'create')).toBe('https://mj.yuansucang.cn/open-api/v1/generations');
    expect(providerEndpoint('dola-sd2', 'status')).toBe('https://mj.yuansucang.cn/open-api/v1/tasks/{id}');
    expect(providerEndpoint('dola-sd2', 'create', { DOLA_SD2_BASE_URL: 'https://mj.yuansucang.cn' })).toBe('https://mj.yuansucang.cn/open-api/v1/generations');
    expect(() => providerEndpoint('dola-sd2', 'content')).toThrow('provider_content_unsupported');
  });

  it('sends the measured api_id, raw base64 and a stable matching idempotency header', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ api_id: 'api_hmstudio_seedance_v2_0', prompt: 'portrait', duration: 5, request_id: 'workspace-task-1', face_processing: 'customer', media_files: { images: [{ name: 'portrait.png', type: 'image/png', data: 'iVBORw==' }] } });
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(body.request_id);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
      return Response.json({ ok: true, task: { id: 'paid-task-1', status: 'processing' } });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await submitVideo(input, { env, fetch: fetcher as typeof fetch });
      expect(normalizeProviderResponse('dola-sd2', result.response)).toMatchObject({ providerTaskId: 'paid-task-1', status: 'running', outputUrls: [] });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ referenceFiles: [] }, 'reference_images_required'],
    [{ referenceFiles: [reference, reference] }, 'too_many_reference_images'],
    [{ referenceAudios: ['https://example.test/audio.mp3'] }, 'too_many_reference_audios'],
    [{ referenceVideos: ['https://example.test/video.mp4'] }, 'too_many_reference_videos'],
    [{ duration: 5.5 }, 'unsupported_duration'],
    [{ duration: 16 }, 'unsupported_duration'],
    [{ aspectRatio: '16:9' }, 'unsupported_aspect_ratio'],
    [{ resolution: '1080p' }, 'unsupported_resolution'],
    [{ referenceFiles: [{ ...reference, mimeType: 'video/mp4' }] }, 'reference_asset_file_invalid'],
  ] as const)('rejects unsupported input before a paid submission: %j', async (change, error) => {
    const fetcher = vi.fn();
    await expect(submitVideo({ ...input, ...change } as SubmitVideoInput, { env, fetch: fetcher })).rejects.toThrow(error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates the request id and accepts the documented duration endpoints', () => {
    for (const duration of [4, 15]) expect(buildDolaSd2VideoPayload({ ...input, requestId: 'fixed', duration, references: [reference] })).toMatchObject({ duration });
    expect(() => buildDolaSd2VideoPayload({ ...input, requestId: '', references: [reference] })).toThrow('request_id_required');
  });

  it('downloads public external images without disclosing the provider key', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') {
        expect(String(url)).toBe('https://93.184.216.34/portrait.png');
        expect(new Headers(init.headers).has('authorization')).toBe(false);
        expect(init.redirect).toBe('error');
        return new Response(reference.bytes, { headers: { 'content-type': 'image/png' } });
      }
      expect(JSON.parse(String(init?.body)).media_files.images[0].data).toBe('iVBORw==');
      return Response.json({ ok: true, task: { id: 'paid-task-1', status: 'processing' } });
    });
    await submitVideo({ ...input, referenceFiles: [], referenceImages: ['https://93.184.216.34/portrait.png'] }, { env, fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('blocks internal external-reference targets before fetching or billing', async () => {
    const fetcher = vi.fn();
    await expect(submitVideo({ ...input, referenceFiles: [], referenceImages: ['https://127.0.0.1/image.png'] }, { env, fetch: fetcher })).rejects.toThrow('image_url_target_blocked');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains extensionless signed output URLs and excludes echoed image references', () => {
    expect(normalizeProviderResponse('dola-sd2', { ok: true, task: { id: 'paid-task-1', status: 'succeeded', output_url: signedUrl, media_files: { images: [{ data: 'A'.repeat(64), url: 'https://example.test/reference.png' }] } } })).toEqual({ providerTaskId: 'paid-task-1', status: 'completed', progress: 100, outputUrls: [signedUrl], outputBase64: [] });
  });

  it.each([['submitting', 'queued'], ['processing', 'running'], ['review', 'running'], ['succeeded', 'completed'], ['failed', 'failed']])('maps supplier state %s to %s', (rawStatus, status) => {
    expect(normalizeProviderResponse('dola-sd2', { ok: true, task: { id: 'paid-task-1', status: rawStatus } })).toMatchObject({ providerTaskId: 'paid-task-1', status });
  });

  it('surfaces task failure details and failed envelopes', () => {
    expect(normalizeProviderResponse('dola-sd2', { ok: true, task: { id: 'paid-task-1', status: 'failed', error: { code: 'upstream_task_failed', message: 'generation failed' } } })).toMatchObject({ status: 'failed', error: 'provider_upstream_failed' });
    expect(normalizeProviderResponse('dola-sd2', { ok: false, error: { code: 'invalid_request' } })).toMatchObject({ status: 'failed', error: 'provider_invalid_request' });
  });

  it('can poll the same accepted task after a transient 502 without another POST', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 })).mockResolvedValueOnce(Response.json({ ok: true, task: { id: 'paid-task-1', status: 'succeeded', output_url: signedUrl } }));
    await expect(syncProviderTask('dola-sd2', 'paid-task-1', { env, fetch: fetcher })).rejects.toThrow('provider_502');
    expect(await syncProviderTask('dola-sd2', 'paid-task-1', { env, fetch: fetcher })).toMatchObject({ providerTaskId: 'paid-task-1', status: 'completed', outputUrls: [signedUrl] });
    for (const call of fetcher.mock.calls) {
      expect(call[0]).toBe('https://mj.yuansucang.cn/open-api/v1/tasks/paid-task-1');
      expect(call[1].method).toBe('GET');
    }
  });

  it('reports insufficient balance instead of a mock success', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: false, error: { code: 'insufficient_balance' } }, { status: 402 }));
    await expect(submitVideo(input, { env, fetch: fetcher })).rejects.toThrow('provider_402');
    await expect(submitVideo(input, { env: { WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true' }, fetch: fetcher })).rejects.toThrow('provider_not_configured');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
