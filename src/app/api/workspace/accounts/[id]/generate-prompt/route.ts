import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { generateGeminiPrompt, generateGPTPrompt, generateBigSnakePrompt } from '@/lib/providers/client';
import { getProviderConfig, type ProviderId } from '@/lib/providers/config';
import { createProviderTask } from '@/lib/providers/taskStore';

type PromptRequestBody = {
  title?: unknown;
  prompt?: unknown;
  description?: unknown;
  pid?: unknown;
  promptModel?: unknown;
};

/**
 * Generate a child prompt for an account workspace.
 *
 * The production form exposes two prompt engines: the GPT-2999 Responses
 * endpoint and the Gemini generateContent endpoint.  Keep the provider/model
 * recorded on the task in lock-step with the engine that was actually called.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) {
    return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as PromptRequestBody;
  const rawTitle = typeof body.title === 'string' ? body.title : body.prompt;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : '商品';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const requestedPromptModel = typeof body.promptModel === 'string' && body.promptModel.trim()
    ? body.promptModel.trim()
    : 'gemini-2.5-flash';

  // `gpt-2999` is the UI alias.  Also accept a concrete GPT model id so a
  // future UI can pass one directly; all other values must be Gemini models.
  const isBigSnake = requestedPromptModel === 'bigsnake' || requestedPromptModel.startsWith('bigsnake:');
  const isGpt = requestedPromptModel === 'gpt-2999' || /^gpt[-_]/i.test(requestedPromptModel);
  const isGemini = /^gemini[-_]/i.test(requestedPromptModel);
  if (!isGpt && !isGemini && !isBigSnake) {
    return NextResponse.json({ success: false, error: 'prompt_model_invalid' }, { status: 400 });
  }

  const generationPrompt = `请为商品“${title}”生成适合 TikTok 带货视频的子提示词。${description}`;
  try {
    let provider: ProviderId;
    let model: string;
    let generatedText: string;
    let source: 'live' | 'mock';

    if (isBigSnake) {
      provider = 'bigsnake-prompt';
      const config = getProviderConfig(provider);
      model = requestedPromptModel.startsWith('bigsnake:') ? requestedPromptModel.slice('bigsnake:'.length) : config.model;
      const generated = await generateBigSnakePrompt({ model, prompt: generationPrompt });
      generatedText = generated.text;
      source = generated.mode;
    } else if (isGpt) {
      provider = 'gpt-2999-prompt';
      const config = getProviderConfig(provider);
      // The alias selects the GPT provider; the configured model is the one
      // sent to /v1/responses and therefore the one persisted in task history.
      model = /^gpt[-_]/i.test(requestedPromptModel) && requestedPromptModel !== 'gpt-2999'
        ? requestedPromptModel
        : config.model;
      const generated = await generateGPTPrompt({
        model,
        messages: [{ role: 'user', content: generationPrompt }],
      });
      generatedText = generated.text;
      source = generated.mode;
    } else {
      provider = 'yuanai-gemini-prompt';
      const config = getProviderConfig(provider);
      // Pass the selected Gemini model through to the provider.  If the UI
      // leaves it blank, the provider's configured default is used.
      model = isGemini ? requestedPromptModel : config.model;
      const generated = await generateGeminiPrompt({ prompt: generationPrompt, model });
      generatedText = generated.text;
      source = generated.mode;
    }

    const ownerId = workspaceOwnerIdForAccount(id);
    const metadata: Record<string, unknown> = {
      ...(ownerId ? { ownerId } : {}),
      source,
      generatedText,
      requestedPromptModel,
      ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}),
    };
    const task = createProviderTask({
      accountId: id,
      mode: 'prompt',
      provider,
      model,
      prompt: title,
      status: 'completed',
      progress: 100,
      metadata,
    });
    return NextResponse.json({
      success: true,
      data: {
        accountId: id,
        taskId: task.id,
        prompt: generatedText,
        source,
        provider: task.provider,
        model: task.model,
        status: task.status,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'provider_not_configured') {
      return NextResponse.json({ success: false, error: message }, { status: 503 });
    }
    if (message.startsWith('provider_')) {
      return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
    if (message === 'prompt_model_invalid') {
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'prompt_provider_failed' }, { status: 502 });
  }
}
