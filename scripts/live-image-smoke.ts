import { readFileSync } from 'node:fs';
import { generatePomoAIImage, generateYuanAIImage } from '../src/lib/providers/client';

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)=(.*)\s*$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function summarize(provider: string, result: unknown) {
  if (!result || typeof result !== 'object') return { provider, kind: typeof result };
  const value = result as Record<string, unknown>;
  const response = value.response;
  const summary: Record<string, unknown> = {
    provider,
    mode: value.mode,
    responseType: response && typeof response === 'object' ? 'object' : typeof response,
  };
  if (response && typeof response === 'object') {
    const root = response as Record<string, unknown>;
    summary.responseKeys = Object.keys(root).slice(0, 12);
    summary.hasCandidates = Array.isArray(root.candidates);
    summary.hasData = Array.isArray(root.data);
    summary.hasOutput = Array.isArray(root.output);
    summary.hasOutputText = typeof root.output_text === 'string';
    summary.status = typeof root.status === 'string' ? root.status : undefined;
    if (Array.isArray(root.candidates)) {
      const first = root.candidates[0];
      const parts = first && typeof first === 'object' && (first as Record<string, unknown>).content && typeof (first as Record<string, unknown>).content === 'object'
        ? (first as Record<string, unknown>).content as Record<string, unknown>
        : undefined;
      const blocks = parts && Array.isArray(parts.parts) ? parts.parts : [];
      summary.candidatePartKinds = blocks.map((part) => part && typeof part === 'object' ? Object.keys(part as Record<string, unknown>) : typeof part);
      const inline = blocks.find((part) => part && typeof part === 'object' && (part as Record<string, unknown>).inlineData) as Record<string, unknown> | undefined;
      if (inline && inline.inlineData && typeof inline.inlineData === 'object') {
        const data = inline.inlineData as Record<string, unknown>;
        summary.inlineMimeType = data.mimeType;
        summary.inlineDataLength = typeof data.data === 'string' ? data.data.length : 0;
      }
    }
    if (Array.isArray(root.data)) {
      const first = root.data[0];
      if (first && typeof first === 'object') {
        const data = first as Record<string, unknown>;
        summary.dataEntryKeys = Object.keys(data);
        summary.dataUrlProtocol = typeof data.url === 'string' ? data.url.slice(0, 8) : undefined;
        summary.dataB64Length = typeof data.b64_json === 'string' ? data.b64_json.length : 0;
      }
    }
  }
  return summary;
}

async function main() {
  const env = {
    ...loadEnv('D:/all_projects/workspace/.env.local'),
    WORKSPACE_ENABLE_LIVE_PROVIDERS: 'true',
  };
  const prompt = 'A simple blue square centered on a white background, no text.';

  const tinyPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const calls = [
    generatePomoAIImage({ model: env.POMOAI_MODEL || 'gemini-3.1-flash-image', prompt }, { env }),
    generatePomoAIImage({ model: env.POMOAI_MODEL || 'gemini-3.1-flash-image', prompt: 'Create a polished product photo based on this reference.', references: [{ mimeType: 'image/png', dataBase64: Buffer.from(tinyPng).toString('base64') }] }, { env }),
    generateYuanAIImage({ model: env.YUANAI_IMAGE_MODEL || 'gpt-image-2', prompt, aspectRatio: '1:1', resolution: '1k' }, { env }),
    generateYuanAIImage({ model: env.YUANAI_IMAGE_MODEL || 'gpt-image-2', prompt: 'Add a small red dot to the center.', aspectRatio: '1:1', resolution: '1k', referenceFiles: [{ bytes: tinyPng, mimeType: 'image/png', fileName: 'reference.png' }] }, { env }),
  ];

  const results = await Promise.allSettled(calls);
  for (const [index, result] of results.entries()) {
    const provider = index === 0 ? 'pomoai-gemini-image' : index === 1 ? 'pomoai-gemini-image-reference' : index === 2 ? 'yuanai-image-generation' : 'yuanai-image-edits';
    if (result.status === 'fulfilled') {
      console.log(JSON.stringify(summarize(provider, result.value)));
    } else {
      const message = result.reason instanceof Error ? result.reason.message : 'unknown_error';
      console.log(JSON.stringify({ provider, error: message === 'provider request failed' ? message : message.slice(0, 160) }));
    }
  }
}

void main();
