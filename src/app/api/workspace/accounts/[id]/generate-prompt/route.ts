import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { generateGeminiPrompt, generateGPTPrompt, generateBigSnakePrompt, generateOAIRegboxGPTPrompt, generateSecureSkillGPTPrompt, generatePromptWithFallback } from '@/lib/providers/client';
import { providerResponseSnapshot } from '@/lib/providers/client';
import { getProviderConfig, type ProviderId } from '@/lib/providers/config';
import { createProviderTask } from '@/lib/providers/taskStore';
import { readAssetFile } from '@/lib/workspace/assetStore';
import { getProductImageAbsolutePath, readProductImageAsset } from '@/lib/workspace/productImages';
import { appendProductSummary, lookupProductSummary } from '@/lib/workspace/productSummary';
import * as productSummaryModule from '@/lib/workspace/productSummary';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import type { GPTPromptAttachment } from '@/lib/providers/payloads';
import fs from 'node:fs';

type PromptRequestBody = {
  title?: unknown;
  prompt?: unknown;
  description?: unknown;
  pid?: unknown;
  promptModel?: unknown;
  referenceAssetIds?: unknown;
  productImageAssetIds?: unknown;
};

const MAX_REFERENCE_IMAGES = 10;
const MAX_REFERENCE_BYTES = 40 * 1024 * 1024;

/**
 * Generate a child prompt for an account workspace.
 *
 * The production form can use the GPT-5.5 Responses fallback chain, the
 * legacy GPT-2999 Responses endpoint, or the Gemini generateContent endpoint.
 * Keep the provider/model recorded on the task in lock-step with the engine
 * that was actually called.
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
    : 'pomoai-gpt';

  // `gpt-2999` is the UI alias.  Also accept a concrete GPT model id so a
  // future UI can pass one directly; all other values must be Gemini models.
  const isPomoFallback = requestedPromptModel === 'pomoai-gpt' || requestedPromptModel === 'pomoai-gpt-prompt' || requestedPromptModel.startsWith('pomoai:');
  const isOAIRegbox = requestedPromptModel === 'oairegbox-gpt' || requestedPromptModel === 'oairegbox-gpt-prompt';
  const isSecureSkill = requestedPromptModel === 'secure-skill-gpt' || requestedPromptModel === 'secure-skill-gpt-prompt';
  const isBigSnake = requestedPromptModel === 'bigsnake' || requestedPromptModel.startsWith('bigsnake:');
  const isGpt = requestedPromptModel === 'gpt-2999' || /^gpt[-_]/i.test(requestedPromptModel);
  const isGemini = /^gemini[-_]/i.test(requestedPromptModel);
  if (!isPomoFallback && !isOAIRegbox && !isSecureSkill && !isGpt && !isGemini && !isBigSnake) {
    return NextResponse.json({ success: false, error: 'prompt_model_invalid' }, { status: 400 });
  }

  const referenceAssetIds = parseStringList(body.referenceAssetIds);
  const productImageAssetIds = parseStringList(body.productImageAssetIds);
  if (referenceAssetIds.length + productImageAssetIds.length > MAX_REFERENCE_IMAGES) {
    return NextResponse.json({ success: false, error: 'too_many_reference_images' }, { status: 400 });
  }
  // Resolve the provider before entering the generation try/catch.  This
  // lets every failure response identify the supplier that was actually
  // selected, even when the provider throws an unclassified network error.
  const selectedProvider: ProviderId = isPomoFallback
    ? 'pomoai-gpt-prompt'
    : isOAIRegbox
      ? 'oairegbox-gpt-prompt'
      : isSecureSkill
        ? 'secure-skill-gpt-prompt'
      : isBigSnake
    ? 'bigsnake-prompt'
    : isGpt
      ? 'gpt-2999-prompt'
      : 'yuanai-gemini-prompt';
  const selectedProviderName = selectedProvider === 'bigsnake-prompt'
    ? 'BigSnake'
    : selectedProvider === 'gpt-2999-prompt'
      ? 'GPT-2999'
      : selectedProvider === 'oairegbox-gpt-prompt' ? 'OAIRegBox GPT-5.5' : selectedProvider === 'secure-skill-gpt-prompt' ? 'secure-skill GPT-5.5 Medium' : selectedProvider === 'pomoai-gpt-prompt' ? 'PomoAI GPT-5.5' : 'Gemini';
  let attemptedModel = '';
  try {
    const referenceImageName = firstReferenceImageName({ accountId: id, referenceAssetIds, productImageAssetIds });
    const accountLookup = (productSummaryModule as typeof productSummaryModule & { lookupProductSummaryForAccount?: typeof lookupProductSummary }).lookupProductSummaryForAccount;
    const productSummary = typeof accountLookup === 'function' ? accountLookup(id, referenceImageName) : lookupProductSummary(referenceImageName);
    const generationPrompt = appendProductSummary(`请为商品“${title}”生成适合 TikTok 带货视频的子提示词。${description}`, productSummary);
    const references = readPromptImageReferences(id, referenceAssetIds, productImageAssetIds);
    let provider: ProviderId = selectedProvider;
    let model: string;
    let generatedText: string;
    let source: 'live' | 'mock';
    let fallbackFrom: ProviderId | undefined;
    let fallbackProviders: ProviderId[] | undefined;
    let fallbackModels: string[] | undefined;

    if (isPomoFallback) {
      const selectedPomoModel = requestedPromptModel.startsWith('pomoai:') ? requestedPromptModel.slice('pomoai:'.length).trim() : undefined;
      const generated = await generatePromptWithFallback({ model: selectedPomoModel || undefined, prompt: generationPrompt, attachments: references });
      provider = generated.provider;
      model = generated.model;
      attemptedModel = model;
      generatedText = generated.text;
      source = generated.mode;
      fallbackFrom = generated.fallbackFrom;
      fallbackProviders = generated.fallbackProviders;
      fallbackModels = generated.fallbackModels;
    } else if (isOAIRegbox) {
      provider = 'oairegbox-gpt-prompt';
      const generated = await generateOAIRegboxGPTPrompt({ prompt: generationPrompt, attachments: references });
      model = generated.model;
      attemptedModel = model;
      generatedText = generated.text;
      source = generated.mode;
    } else if (isSecureSkill) {
      provider = 'secure-skill-gpt-prompt';
      const generated = await generateSecureSkillGPTPrompt({ prompt: generationPrompt, attachments: references });
      model = generated.model;
      attemptedModel = model;
      generatedText = generated.text;
      source = generated.mode;
    } else if (isBigSnake) {
      provider = 'bigsnake-prompt';
      const config = getProviderConfig(provider);
      model = requestedPromptModel.startsWith('bigsnake:') ? requestedPromptModel.slice('bigsnake:'.length) : config.model;
      attemptedModel = model;
      const generated = await generateBigSnakePrompt({ model, prompt: generationPrompt, attachments: references });
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
      attemptedModel = model;
      const generated = await generateGPTPrompt({
        model,
        messages: [{ role: 'user', content: generationPrompt }],
        attachments: references,
      });
      generatedText = generated.text;
      source = generated.mode;
    } else {
      provider = 'yuanai-gemini-prompt';
      const config = getProviderConfig(provider);
      // Pass the selected Gemini model through to the provider.  If the UI
      // leaves it blank, the provider's configured default is used.
      model = isGemini ? requestedPromptModel : config.model;
      attemptedModel = model;
      const generated = await generateGeminiPrompt({ prompt: generationPrompt, model, references });
      generatedText = generated.text;
      source = generated.mode;
    }

    const ownerId = workspaceOwnerIdForAccount(id);
    const metadata: Record<string, unknown> = {
      ...(ownerId ? { ownerId } : {}),
      source,
      generatedText,
      requestedPromptModel,
      promptProvider: provider,
      promptModel: model,
      promptGenerationSource: source,
      ...(referenceImageName ? { referenceImageName } : {}),
      ...(productSummary ? { productSummary } : { productSummaryLookup: referenceImageName ? 'not_found' : 'no_reference_name' }),
      ...(references.length ? { referenceImageCount: references.length } : {}),
      ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}),
      ...(fallbackFrom ? { promptFallbackFrom: fallbackFrom } : {}),
      ...(fallbackProviders?.length ? { promptFallbackProviders: fallbackProviders } : {}),
      ...(fallbackModels?.length ? { promptFallbackModels: fallbackModels } : {}),
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
    const fallbackDetails = error && typeof error === 'object'
      ? error as { promptProvider?: unknown; promptModel?: unknown; promptFallbackFrom?: unknown; promptFallbackProviders?: unknown }
      : {};
    const context = {
      provider: selectedProvider,
      providerName: selectedProviderName,
      ...(typeof fallbackDetails.promptModel === 'string' && fallbackDetails.promptModel.trim()
        ? { model: fallbackDetails.promptModel.trim() }
        : attemptedModel ? { model: attemptedModel } : {}),
      requestedPromptModel,
    };
    if (message === 'provider_not_configured') {
      return NextResponse.json({ success: false, error: message, ...context }, { status: 503 });
    }
    if (message.startsWith('provider_')) {
      return NextResponse.json({ success: false, error: message, ...context, providerResponse: providerResponseSnapshot(error) }, { status: 502 });
    }
    if (message === 'prompt_model_invalid') {
      return NextResponse.json({ success: false, error: message, ...context }, { status: 400 });
    }
    if (message === 'reference_asset_not_found' || message === 'reference_images_too_large' || message === 'too_many_reference_images') {
      return NextResponse.json({ success: false, error: message, ...context }, { status: 400 });
    }
    // Keep the stable generic code for backwards-compatible UI translation,
    // while returning the concrete provider/model so BigSnake failures can
    // never be mistaken for GPT-2999 failures.
    return NextResponse.json({
      success: false,
      error: 'prompt_provider_failed',
      ...context,
      providerResponse: providerResponseSnapshot(error),
    }, { status: 502 });
  }
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim()))].slice(0, MAX_REFERENCE_IMAGES);
}

function readPromptImageReferences(accountId: string, referenceAssetIds: readonly string[], productImageAssetIds: readonly string[]): GPTPromptAttachment[] {
  const references: GPTPromptAttachment[] = [];
  let totalBytes = 0;
  for (const assetId of referenceAssetIds) {
    const stored = readAssetFile(accountId, assetId);
    if (!stored || stored.asset.kind !== 'image') throw new Error('reference_asset_not_found');
    totalBytes += stored.bytes.byteLength;
    if (totalBytes > MAX_REFERENCE_BYTES) throw new Error('reference_images_too_large');
    references.push({ name: stored.asset.name, mimeType: stored.asset.mimeType || 'image/png', dataBase64: Buffer.from(stored.bytes).toString('base64') });
  }
  for (const assetId of productImageAssetIds) {
    const product = readProductImageAsset(assetId);
    if (!product) throw new Error('reference_asset_not_found');
    // Shared product images are workspace-wide assets. Do not require them to
    // belong to the current account lane here; the preview/import layer already
    // validated that the asset exists under the local workspace root.
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(getProductImageAbsolutePath(assetId));
    } catch {
      throw new Error('reference_asset_not_found');
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_REFERENCE_BYTES) throw new Error('reference_images_too_large');
    references.push({ name: product.name, mimeType: product.mimeType || 'image/png', dataBase64: bytes.toString('base64') });
  }
  return references;
}
