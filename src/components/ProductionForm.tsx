'use client';

import { Download, Film, Image as ImageIcon, LoaderCircle, Save, Search, WandSparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getProviderCatalog, type ProviderCatalogEntry, type ProviderId } from '@/lib/providers/config';
import {
  getDefaultVideoAspectRatio,
  getDefaultVideoDuration,
  getDefaultVideoResolution,
  getVideoCapability,
  getVideoDurationOptions,
  type VideoCapability,
} from '@/lib/workspace/production/video-capabilities';
import {
  buildGenerationPayload,
  type ProductionAssetSelection,
  type PromptMode,
  validateProductionInput,
} from './productionFormModel';
import type { TaskNameMode } from '@/lib/workspace/taskNaming';
import type { ProductionRestoreConfig } from '@/lib/workspace/productionRestore';
import { getDefaultImageResolution, getDefaultProductionAspectRatio } from '@/lib/workspace/production/defaults';
import { formatProviderError } from '@/lib/providers/errorMessages';
import * as XLSX from 'xlsx';
import { normalizeProductGalleryItems, parsePidListText, parsePidRows } from './productImageAssetsModel';

type Props = { accountId: string; mode: 'image' | 'prompt' | 'video' };
type PromptAsset = { id: string; name: string; content: string; category?: 'image' | 'video'; accountName?: string };
type MediaAsset = { id: string; name: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio'; mimeType?: string; pid?: string; shared?: boolean; coverUrl?: string; url?: string; relativePath?: string; imageCount?: number };

const VIDEO_CAPABILITY_KEYS: Partial<Record<ProviderId, string>> = {
  'yuanai-grok-video': 'yuanai-grok-video:grok-imagine-video-1.5-preview',
  'grok-video': 'grok-video:grok-imagine-video-1.5（按次）',
  'mgrouter-grok-video': 'mgrouter-grok-video:grok-video',
  'wan3-video': 'wan3-video:wan3.0-r2v',
  'wan-3-nsfw': 'wan-3-nsfw:wan-3',
  'miku-minimax': 'miku-minimax:minimax-h3-max',
  'oairegbox-omni': 'oairegbox:omni',
  'minimax-h3': 'minimax-h3:minimax-h3',
  'pro666-video': 'pro666-video:sd2-933-mini',
  'quality-v4': 'quality-v4:quality-v4',
};

/**
 * Resolve the wire-level model id for a selected supplier.  Grok is exposed
 * by two gateways with different model identifiers: snumom expects the
 * published Imagine/Video names, while MGRouter uses the canonical
 * `grok-imagine-video-1.5` id from its model catalog.
 * Keeping this mapping in one pure helper prevents the provider select from
 * accidentally submitting a model id that belongs to the other gateway.
 */
export function modelIdForVideoProvider(provider: ProviderId, currentModelId?: string): string {
  if (provider === 'quality-v4') return 'quality-v4';
  if (provider === 'oairegbox-omni') return 'omni-fast-no-water';
  if (provider === 'wan3-video') {
    return currentModelId?.startsWith('wan3.0-') ? currentModelId : 'wan3.0-r2v';
  }
  if (provider === 'wan-3-nsfw') return 'wan-3';
  if (provider === 'miku-minimax') return 'minimax-h3-max';
  if (provider === 'minimax-h3') {
    // secure-skill exposes one live MiniMax H3 model. Historical r2v/t2v
    // ids are accepted only when reading old task records; every new form
    // state and submission uses the documented canonical id.
    return 'minimax-h3';
  }
  if (provider === 'pro666-video') return 'sd2-933-mini';
  if (provider === 'mgrouter-grok-video') return currentModelId === 'grok-imagine-video-1.5-preview' ? currentModelId : 'grok-imagine-video-1.5';
  if (provider === 'yuanai-grok-video') return 'grok-imagine-video-1.5-preview';
  if (provider === 'grok-video') {
    if (currentModelId === 'sd-mini') return currentModelId;
    return currentModelId === 'grok-video-1.5（按秒）' || currentModelId === 'grok-video-1.5'
      ? 'grok-video-1.5（按秒）'
      : 'grok-imagine-video-1.5（按次）';
  }
  return currentModelId || 'grok-imagine-video-1.5（按次）';
}
export const VIDEO_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'grok-imagine-video-1.5（按次）', label: 'Grok Imagine Video 1.5（按次）' },
  { id: 'grok-video-1.5（按秒）', label: 'Grok Video 1.5（按秒）' },
  // MGRouter exposes Grok through its own OpenAI-compatible model id.  Keep
  // it in the canonical list but only show it when that supplier is selected.
  { id: 'grok-imagine-video-1.5', label: 'Grok Imagine Video 1.5（MGRouter）' },
  { id: 'grok-imagine-video-1.5-preview', label: 'Grok Imagine Video 1.5 Preview' },
  { id: 'quality-v4', label: 'Quality V4' },
  // Backward-compatible alias for restored links/tasks; hidden from the
  // selector while still exported for historical callers.
  { id: 'sd-mini', label: 'sd-mini（按条 $0.6）' },
  { id: 'omni-fast-no-water', label: 'Omni Fast No Water' },
  { id: 'wan3.0-r2v', label: 'Wan 3.0 R2V' },
  { id: 'wan-3', label: 'Wan 3 NSFW' },
  // Retired prime ids: kept exported for restore compatibility, hidden from the
  // live supplier selector below.
  { id: 'wan3.0-prime-t2v', label: 'Wan 3.0 Prime T2V (legacy)' },
  { id: 'wan3.0-prime-i2v', label: 'Wan 3.0 Prime I2V (legacy)' },
  { id: 'wan3.0-prime-r2v', label: 'Wan 3.0 Prime R2V (legacy)' },
  { id: 'minimax-h3', label: 'MiniMax H3' },
  { id: 'minimax-h3-max', label: 'MiniMax H3 Max（MikuAPI）' },
  { id: 'sd2-933-mini', label: 'sd2-933-mini / Pro666' },
  // Legacy ids remain exported for restore compatibility but are hidden from
  // the live supplier selector below.
  { id: 'minimax-h3-r2v', label: 'MiniMax H3 R2V (legacy)' },
  { id: 'minimax-h3-t2v', label: 'MiniMax H3 T2V (legacy)' },
];
const VIDEO_ROUTING_CARDS: ReadonlyArray<{ id: string; label: string; providers: ProviderId[] }> = [
  { id: 'grok', label: 'Grok', providers: ['grok-video', 'mgrouter-grok-video', 'yuanai-grok-video'] },
  { id: 'omni-fast-no-water', label: 'Omni', providers: ['oairegbox-omni'] },
  { id: 'minimax-h3', label: 'MiniMax H3', providers: ['minimax-h3'] },
  { id: 'minimax-h3-max', label: 'H3 Max', providers: ['miku-minimax'] },
  { id: 'sd2-933-mini', label: 'sd2-933-mini', providers: ['pro666-video'] },
  { id: 'wan3.0-r2v', label: 'Wan 3.0', providers: ['wan3-video'] },
  { id: 'wan-3', label: 'Wan 3 NSFW', providers: ['wan-3-nsfw'] },
  { id: 'quality-v4', label: 'Quality V4', providers: ['quality-v4'] },
  { id: 'seedance', label: 'Seedance', providers: [] },
];
const IMAGE_ROUTING_CARDS: ReadonlyArray<{ id: string; label: string; providers: ProviderId[] }> = [
  { id: 'grok-image', label: 'Grok', providers: ['mgrouter-grok-image', 'origin-grok-image'] },
  { id: 'gemini-image', label: 'Gemini', providers: ['pomoai-gemini-image', 'origin-nano-image', 'junze-gemini-image'] },
  { id: 'gpt-image', label: 'GPT Image', providers: ['aicloud-gpt-image', 'origin-gpt-image', 'junze-gpt-image', 'yuanai-image'] },
  { id: 'seedream', label: 'Seedream', providers: ['seedream'] },
];

/** Kept as a small pure helper for callers/tests that used the previous form API. */
export function validateGenerationInput(mode: Props['mode'], input: { prompt: string; referenceImages: string[]; referenceAudios: string[] }, maxReferenceImages = 10): string | null {
  if (!input.prompt.trim()) return mode === 'prompt' ? '请输入商品上下文或提示词' : '请输入提示词';
  if (input.referenceImages.length > maxReferenceImages) return mode === 'image' ? `生图最多选择 ${maxReferenceImages} 张参考图` : '视频最多选择 10 张参考图';
  if (mode !== 'video' && input.referenceAudios.length > 0) return '当前模式不支持音频参考';
  if (input.referenceAudios.length > 5) return '视频最多选择 5 条参考音频';
  return null;
}

export function ProductionForm({ accountId, mode }: Props) {
  const searchParams = useSearchParams();
  const restoreTaskId = searchParams.get('restoreTaskId');
  const restoredTaskRef = useRef<string | null>(null);
  const providers = useMemo(() => getProviderCatalog().filter((provider) => provider.kind === mode), [mode]);
  const promptProviders = useMemo(() => getProviderCatalog().filter((provider) => provider.kind === 'prompt'), []);
  const initialProvider = (mode === 'image' ? providers.find((item) => item.id === 'aicloud-gpt-image') ?? providers.find((item) => item.id === 'yuanai-image') : providers[0])?.id ?? 'grok-video';
  const initialProviderEntry = providers.find((item) => item.id === initialProvider) ?? providers[0];
  const [prompt, setPrompt] = useState('');
  const promptDraftKey = `workspace-production-prompt:${accountId}:${mode}`;
  const [promptHydrated, setPromptHydrated] = useState(false);
  const [originalPrompt, setOriginalPrompt] = useState('');
  const [childPrompt, setChildPrompt] = useState('');
  const [finalPrompt, setFinalPrompt] = useState('');
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [imageModelId, setImageModelId] = useState(() => mode === 'image' ? (initialProviderEntry?.model ?? '') : '');
  const [videoModelId, setVideoModelId] = useState(() => mode === 'video' ? modelIdForVideoProvider(initialProvider) : 'grok-imagine-video-1.5（按次）');
  const [promptMode, setPromptMode] = useState<PromptMode>('manual');
  const [promptModel, setPromptModel] = useState('pomoai-gpt');
  const [templateId, setTemplateId] = useState('');
  const [promptTemplates, setPromptTemplates] = useState<PromptAsset[]>([]);
  const [promptTemplateName, setPromptTemplateName] = useState(mode === 'image' ? '图片提示词模板' : '视频提示词模板');
  const [savingPromptTemplate, setSavingPromptTemplate] = useState(false);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [restoredExternalImages, setRestoredExternalImages] = useState<string[]>([]);
  const [restoredExternalVideos, setRestoredExternalVideos] = useState<string[]>([]);
  const [restoredExternalAudios, setRestoredExternalAudios] = useState<string[]>([]);
  const [suffixEnabled, setSuffixEnabled] = useState(false);
  const [suffix, setSuffix] = useState('');
  const [taskNameMode, setTaskNameMode] = useState<TaskNameMode>('auto');
  const [taskName, setTaskName] = useState('');
  const [count, setCount] = useState(1);
  const [aspectRatio, setAspectRatio] = useState(() => getDefaultProductionAspectRatio(initialProviderEntry?.supports.ratios ?? ['9:16']));
  const [duration, setDuration] = useState('10');
  const [resolution, setResolution] = useState(() => mode === 'image'
    ? getDefaultImageResolution(initialProviderEntry?.modelResolutions?.[initialProviderEntry.model] ?? initialProviderEntry?.supports.resolutions ?? ['1k', '2k'])
    : mode === 'video' ? '720p' : '');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetPickerKind, setAssetPickerKind] = useState<'image' | 'inventory-video' | 'audio'>('image');
  const [assetPickerTab, setAssetPickerTab] = useState<'material' | 'product'>('material');
  const [assetPickerQuery, setAssetPickerQuery] = useState('');
  const [activeProductPid, setActiveProductPid] = useState<string | null>(null);
  const [activeProductFolder, setActiveProductFolder] = useState<string | null>(null);
  const [productFolderImages, setProductFolderImages] = useState<MediaAsset[]>([]);
  // Every folder image ever fetched this session. Selections reference these by
  // id, so the pool must outlive the picker dialog and folder navigation —
  // clearing it while ids are still selected silently drops them from submit.
  const [productImagePool, setProductImagePool] = useState<MediaAsset[]>([]);
  const [loadingProductFolder, setLoadingProductFolder] = useState(false);

  useEffect(() => {
    if (!assetPickerOpen) { setAssetPickerQuery(''); setActiveProductPid(null); setActiveProductFolder(null); setProductFolderImages([]); setLoadingProductFolder(false); }
  }, [assetPickerOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(promptDraftKey);
    if (!restoreTaskId && saved) {
      setPrompt(saved);
      setOriginalPrompt(saved);
    }
    setPromptHydrated(true);
  }, [promptDraftKey, restoreTaskId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !promptHydrated) return;
    if (prompt.trim()) window.localStorage.setItem(promptDraftKey, prompt);
    else window.localStorage.removeItem(promptDraftKey);
  }, [prompt, promptDraftKey, promptHydrated]);

  const selectedProvider = providers.find((item) => item.id === provider) ?? providers[0];
  const selectedImageModel = IMAGE_ROUTING_CARDS.find((card) => card.providers.includes(provider))?.id ?? 'grok-image';
  const imageModelOptions = selectedProvider?.modelOptions ?? [];
  const imageResolutionOptions = selectedProvider?.modelResolutions?.[imageModelId] ?? selectedProvider?.supports.resolutions ?? [];
  const capabilityKey = mode === 'video' && provider === 'wan3-video'
    ? `wan3-video:${videoModelId}`
    : mode === 'video' && provider === 'grok-video'
      ? `grok-video:${videoModelId}`
      : mode === 'video' && provider === 'minimax-h3'
        ? `minimax-h3:${videoModelId.startsWith('minimax-h3-') ? videoModelId : 'minimax-h3'}`
      : mode === 'video' && provider === 'pro666-video'
        ? 'pro666-video:sd2-933-mini'
      : mode === 'video' && provider === 'quality-v4'
        ? 'quality-v4:quality-v4'
      : VIDEO_CAPABILITY_KEYS[provider];
  const capability: VideoCapability | undefined = useMemo(() => mode === 'video' && capabilityKey
    ? getVideoCapabilityByKey(capabilityKey)
    : undefined, [capabilityKey, mode]);

  useEffect(() => {
    const next = mode === 'image'
      ? providers.find((item) => item.id === 'aicloud-gpt-image') ?? providers.find((item) => item.id === 'yuanai-image') ?? providers[0]
      : providers[0];
    if (!next) return;
    setProvider(next.id);
  }, [mode, providers]);

  useEffect(() => {
    if (mode !== 'video') return;
    setVideoModelId((current) => modelIdForVideoProvider(provider, current));
  }, [mode, provider]);

  useEffect(() => {
    if (mode !== 'image' || !selectedProvider) return;
    setImageModelId((current) => selectedProvider.modelOptions?.includes(current) ? current : selectedProvider.model);
  }, [mode, provider, selectedProvider?.model, selectedProvider?.modelOptions]);

  useEffect(() => {
    if (mode !== 'video' || !capability) return;
    if (restoreTaskId && restoredTaskRef.current === restoreTaskId) return;
    const nextRatio = getDefaultVideoAspectRatio(capability.aspectRatios, capability.defaultAspectRatio);
    const nextDuration = getDefaultVideoDuration(capability);
    setAspectRatio(nextRatio);
    setDuration(String(nextDuration));
    setResolution(getDefaultVideoResolution(capability));
  }, [capability, mode]);

  // A provider/model switch starts a new production configuration. Restore
  // the shared defaults so an earlier provider's valid 1:1/2K choice does not
  // leak into the newly selected model (notably Aicloud base -> Plus).
  useEffect(() => {
    if (mode === 'prompt' || !selectedProvider) return;
    setAspectRatio(getDefaultProductionAspectRatio(selectedProvider.supports.ratios));
    if (mode === 'image') setResolution(getDefaultImageResolution(imageResolutionOptions));
  }, [mode, provider, selectedProvider?.model, imageModelId]);

  // Keep duration-dependent resolution combinations valid as duration changes
  // (sd-mini permits 720p only for 10-second jobs).
  useEffect(() => {
    if (mode !== 'video' || !capability) return;
    if (restoreTaskId && restoredTaskRef.current === restoreTaskId) return;
    const allowed = capability.resolutionByDuration?.[Number(duration)] ?? capability.resolutions;
    if (!allowed.includes(resolution as never)) setResolution(allowed[0] ?? getDefaultVideoResolution(capability));
  }, [capability, duration, mode, resolution]);

  useEffect(() => {
    if (mode === 'prompt') return;
    let cancelled = false;
    const promptCategory = mode === 'image' ? 'image' : 'video';
    // Templates are scoped to the account currently being produced. This is
    // intentionally narrower than the operator workspace scope so switching
    // workspaces never exposes another account's private prompt assets.
    setPromptTemplates([]);
    setTemplateId('');
    fetch(`/api/workspace/prompt-templates?accountId=${encodeURIComponent(accountId)}&category=${promptCategory}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: { templates?: PromptAsset[] } }) => {
        if (!cancelled && payload.success) setPromptTemplates((payload.data?.templates ?? []).filter((item) => (item.category ?? 'video') === promptCategory));
      })
      .catch(async () => {
        try {
          const response = await fetch(`/api/workspace/accounts/${accountId}/files?kind=prompt&category=${promptCategory}`, { cache: 'no-store' });
          const payload = await response.json() as { success?: boolean; data?: { assets?: PromptAsset[] } };
          if (!cancelled && payload.success) setPromptTemplates((payload.data?.assets ?? []).filter((item) => (item.category ?? 'video') === promptCategory));
        } catch { if (!cancelled) setPromptTemplates([]); }
      });
    return () => { cancelled = true; };
  }, [accountId, mode]);

  const refreshProductAssets = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspace/product-images?accountId=${encodeURIComponent(accountId)}`, { cache: 'no-store' });
      const payload = await response.json() as { success?: boolean; data?: { folders?: Array<{ pid: string; coverUrl?: string; coverAssetId?: string; imageCount?: number; shared?: boolean }>; imported?: Array<{ pid: string; files: string[] }>; assets?: MediaAsset[] } };
      if (!response.ok || !payload.success) return;
      const shared = (payload.data?.folders ?? []).map((folder) => ({
        id: `product-folder:${folder.pid}`,
        name: folder.pid,
        kind: 'product-image' as const,
        pid: folder.pid,
        shared: folder.shared !== false,
        coverUrl: folder.coverUrl,
        imageCount: folder.imageCount ?? 0,
      }));
      setMediaAssets((current) => [...current.filter((asset) => asset.kind !== 'product-image'), ...shared]);
    } catch { /* product gallery is optional until 8765 is available */ }
  }, [accountId]);

  useEffect(() => {
    if (mode === 'prompt') return;
    let cancelled = false;
    Promise.all(['image', 'inventory-video', 'audio'].map((kind) => fetch(`/api/workspace/accounts/${accountId}/files?kind=${kind}`, { cache: 'no-store' }).then((response) => response.json()).then((payload: { success?: boolean; data?: { assets?: MediaAsset[] } }) => payload.success ? payload.data?.assets ?? [] : []).catch(() => [])))
      .then(async (groups) => {
        let shared: MediaAsset[] = [];
        try {
          const response = await fetch(`/api/workspace/product-images?accountId=${encodeURIComponent(accountId)}`, { cache: 'no-store' });
          const payload = await response.json() as { success?: boolean; data?: { folders?: Array<{ pid: string; coverUrl?: string; imageCount?: number; shared?: boolean }> } };
          if (response.ok && payload.success) shared = (payload.data?.folders ?? []).map((folder) => ({ id: `product-folder:${folder.pid}`, name: folder.pid, kind: 'product-image', pid: folder.pid, shared: folder.shared !== false, coverUrl: folder.coverUrl, imageCount: folder.imageCount ?? 0 }));
        } catch { /* shared product gallery is optional when 8765 data is unavailable */ }
        if (!cancelled) setMediaAssets([...groups.flat(), ...shared]);
      });
    return () => { cancelled = true; };
  }, [accountId, mode]);

  const ratios = capability?.aspectRatios ?? selectedProvider?.supports.ratios ?? ['9:16', '16:9', '1:1'];
  const durationOptions = capability ? getVideoDurationOptions(capability) : selectedProvider?.supports.durations ?? [10];
  const resolutionOptions = capability?.resolutionByDuration?.[Number(duration)]
    ?? capability?.resolutions
    ?? imageResolutionOptions
    ?? (mode === 'image' ? ['1k', '2k'] : ['480p', '720p']);
  useEffect(() => {
    if (mode !== 'image' || !resolutionOptions.length) return;
    if (restoreTaskId && restoredTaskRef.current === restoreTaskId) return;
    const options = resolutionOptions.map((value) => String(value).toLowerCase());
    if (!options.includes(resolution.toLowerCase())) setResolution(getDefaultImageResolution(resolutionOptions.map((value) => String(value))));
  }, [mode, resolution, resolutionOptions, provider]);
  const maxImages = capability?.referenceImages.max ?? selectedProvider?.supports.referenceImages ?? (mode === 'image' ? 3 : 10);
  const maxVideos = capability?.referenceVideos.max ?? (mode === 'video' ? 5 : 0);
  const maxAudios = capability?.referenceAudios.max ?? selectedProvider?.supports.referenceAudios ?? (mode === 'video' ? 5 : 0);
  const acceptedFileTypes = mode === 'image'
    ? 'image/*'
    : [maxImages > 0 ? 'image/*' : '', maxVideos > 0 ? 'video/*' : '', maxAudios > 0 ? 'audio/*' : ''].filter(Boolean).join(',');
  const availableMediaAssets = mediaAssets.filter((asset) => mode === 'image'
    ? (asset.kind === 'image' || asset.kind === 'product-image')
    : asset.kind === 'image' || asset.kind === 'product-image' ? maxImages > 0 : asset.kind === 'inventory-video' ? maxVideos > 0 : maxAudios > 0);
  const productAssetKey = (asset: MediaAsset) => `${asset.shared ? 'shared' : accountId}:${asset.pid ?? ''}`;
  const pickerAssets = useMemo(() => {
    const query = assetPickerQuery.trim().toLowerCase();
    return availableMediaAssets
      .filter((asset) => (assetPickerKind === 'image'
        ? (asset.kind === 'image' || asset.kind === 'product-image')
        : asset.kind === assetPickerKind))
      .filter((asset) => assetPickerKind !== 'image' || (assetPickerTab === 'product' ? asset.kind === 'product-image' : asset.kind === 'image'))
      .filter((asset) => assetPickerKind !== 'image' || assetPickerTab !== 'product' || !activeProductPid || productAssetKey(asset) === activeProductPid)
      .filter((asset) => !query || `${asset.name} ${asset.pid ?? ''}`.toLowerCase().includes(query));
  }, [accountId, activeProductPid, assetPickerKind, assetPickerQuery, assetPickerTab, availableMediaAssets]);
  const productFolders = useMemo(() => {
    const grouped = new Map<string, MediaAsset[]>();
    for (const asset of availableMediaAssets) {
      if (asset.kind !== 'product-image' || !asset.pid) continue;
      const key = productAssetKey(asset);
      const list = grouped.get(key) ?? [];
      list.push(asset);
      grouped.set(key, list);
    }
    return [...grouped.entries()].map(([key, images]) => ({ key, pid: images[0].pid as string, images, cover: images[0], imageCount: images[0].imageCount ?? images.length }));
  }, [accountId, availableMediaAssets]);
  const visibleProductFolder = useMemo(() => productFolders.find((folder) => folder.key === activeProductFolder) ?? null, [activeProductFolder, productFolders]);
  // Folder images are fetched lazily, so they are not part of `mediaAssets`.
  // Every selection lookup has to search both pools or a chosen product image
  // is silently dropped before the queue submission.
  const selectableAssets = useMemo(() => {
    const pool = new Map<string, MediaAsset>();
    for (const asset of mediaAssets) pool.set(asset.id, asset);
    for (const asset of productImagePool) pool.set(asset.id, asset);
    return [...pool.values()];
  }, [mediaAssets, productImagePool]);
  const selectedMediaForDisplay = selectedAssetIds
    .map((id) => selectableAssets.find((asset) => asset.id === id))
    .filter((asset): asset is MediaAsset => Boolean(asset));
  const selectedProductImageIds = selectedMediaForDisplay.filter((asset) => asset.kind === 'product-image').map((asset) => asset.id);
  const selectedReferenceImageName = useMemo(() => {
    const selectedImage = selectedMediaForDisplay.find((asset) => asset.kind === 'image' || asset.kind === 'product-image');
    if (selectedImage?.name?.trim()) return selectedImage.name.trim();
    return droppedFiles.find((file) => fileKind(file) === 'image')?.name?.trim() ?? '';
  }, [droppedFiles, selectedMediaForDisplay]);
  const selectedImageCountForDisplay = selectedMediaForDisplay.filter((asset) => asset.kind === 'image' || asset.kind === 'product-image').length;
  const selectedVideoCountForDisplay = selectedMediaForDisplay.filter((asset) => asset.kind === 'inventory-video').length;
  const selectedAudioCountForDisplay = selectedMediaForDisplay.filter((asset) => asset.kind === 'audio').length;

  // Switching model/supplier must immediately drop references that the new
  // capability cannot consume. This keeps the picker counts and submit guard
  // in sync with the visible capability-specific buttons.
  useEffect(() => {
    if (mode === 'prompt') return;
    setSelectedAssetIds((current) => current.filter((id) => {
      // Keep unresolved IDs while the account asset list or a lazily loaded
      // product folder is still arriving. Dropping them here would make a
      // restored task lose references solely because requests completed in a
      // different order.
      const asset = selectableAssets.find((item) => item.id === id);
      if (!asset) return true;
      if (asset.kind === 'image' || asset.kind === 'product-image') return maxImages > 0;
      if (asset.kind === 'inventory-video') return maxVideos > 0;
      if (asset.kind === 'audio') return maxAudios > 0;
      return false;
    }));
    setDroppedFiles((current) => current.filter((file) => {
      const kind = fileKind(file);
      return kind === 'image' ? maxImages > 0 : kind === 'inventory-video' ? maxVideos > 0 : kind === 'audio' ? maxAudios > 0 : false;
    }));
  }, [mode, selectableAssets, maxImages, maxVideos, maxAudios]);

  // A queue task can be opened as a new draft. The server returns a sanitized
  // restoreConfig so no provider response or short-lived bridge token is
  // copied into the form.
  useEffect(() => {
    if (!restoreTaskId || restoredTaskRef.current === restoreTaskId) return;
    let cancelled = false;
    const endpoint = mode === 'video' ? 'video-tasks' : mode === 'image' ? 'image-tasks' : 'prompt-tasks';
    fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/${endpoint}/${encodeURIComponent(restoreTaskId)}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: { restoreConfig?: ProductionRestoreConfig } }) => {
        if (cancelled || !payload.success || !payload.data?.restoreConfig) return;
        const config = payload.data.restoreConfig;
        // Automatic child-prompt jobs reopen in manual mode. The generated
        // final text becomes the editable prompt so the operator can review
        // or adjust exactly what was submitted upstream.
        const restoredAutoPrompt = config.promptMode === 'asset-template-child-prompt';
        setPrompt(restoredAutoPrompt ? (config.finalPrompt ?? config.childPrompt ?? config.prompt) : config.prompt);
        setOriginalPrompt(config.originalPrompt || config.prompt);
        setChildPrompt(config.childPrompt ?? '');
        setFinalPrompt(config.finalPrompt ?? '');
        setPromptMode(restoredAutoPrompt ? 'manual' : config.promptMode);
        setPromptModel(config.promptModel ?? 'pomoai-gpt');
        setTemplateId(config.templateId ?? '');
        setSuffixEnabled(config.suffixEnabled);
        setSuffix(config.suffix ?? '');
        setTaskNameMode(config.taskNameMode ?? (config.taskName ? 'manual' : 'auto'));
        setTaskName(config.taskName ?? '');
        setCount(config.count || 1);
        setRestoredExternalImages(config.externalReferenceImages);
        setRestoredExternalVideos(config.externalReferenceVideos);
        setRestoredExternalAudios(config.externalReferenceAudios);
        if (config.provider && providers.some((item) => item.id === config.provider)) setProvider(config.provider);
        if (mode === 'video') {
          const restoredModel = config.modelId || config.model;
          if (restoredModel) setVideoModelId(restoredModel);
          if (config.duration) setDuration(String(config.duration));
          if (config.aspectRatio) setAspectRatio(config.aspectRatio);
          if (config.resolution) setResolution(config.resolution);
        } else if (mode === 'image') {
          const restoredImageModel = config.modelId || config.model;
          if (restoredImageModel) setImageModelId(restoredImageModel);
          if (config.aspectRatio) setAspectRatio(config.aspectRatio);
          if (config.resolution) setResolution(config.resolution);
        }
        const ids = config.referenceAssetOrder?.length
          ? config.referenceAssetOrder.map((item) => item.id)
          : [
            ...config.referenceAssetIds,
            ...config.referenceVideoAssetIds,
            ...config.referenceAudioAssetIds,
            ...config.productImageAssetIds,
          ];
        setSelectedAssetIds([...new Set(ids)]);
        // Product images are represented by lightweight folder summaries in
        // the initial asset request. Restore the selected files by lazily
        // loading each referenced PID folder into the local selection pool;
        // otherwise the selected IDs cannot be resolved when the draft is
        // submitted again.
        const restoredProductPids = [...new Set(config.productImageAssetIds
          .map(productPidFromAssetId)
          .filter((pid): pid is string => Boolean(pid)))];
        if (restoredProductPids.length) {
          void Promise.all(restoredProductPids.map(async (pid) => {
            try {
              const response = await fetch(`/api/workspace/product-images?accountId=${encodeURIComponent(accountId)}&pid=${encodeURIComponent(pid)}`, { cache: 'no-store' });
              const payload = await response.json() as { success?: boolean; data?: { folder?: { images?: MediaAsset[] } } };
              if (!response.ok || !payload.success) return [];
              return (payload.data?.folder?.images ?? []).map((asset) => ({ ...asset, kind: 'product-image' as const, shared: true }));
            } catch {
              return [];
            }
          })).then((groups) => {
            const restoredImages = groups.flat();
            if (!restoredImages.length || cancelled) return;
            setProductImagePool((current) => {
              const pool = new Map(current.map((asset) => [asset.id, asset]));
              for (const asset of restoredImages) pool.set(asset.id, asset);
              return [...pool.values()];
            });
          });
        }
        restoredTaskRef.current = restoreTaskId;
        // A restored queue item becomes a new draft; remove the original task
        // so it is not left in the queue as a duplicate.
        void fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/${endpoint}/${encodeURIComponent(restoreTaskId)}`, { method: 'DELETE' }).catch(() => undefined);
        setMessage('已恢复任务配置，可修改后重新提交');
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [accountId, mode, providers, restoreTaskId]);

  function toggleAsset(asset: MediaAsset) {
    setSelectedAssetIds((current) => {
      if (current.includes(asset.id)) return current.filter((id) => id !== asset.id);
      const selected = selectableAssets.filter((item) => current.includes(item.id));
      const isImageAsset = asset.kind === 'image' || asset.kind === 'product-image';
      const count = selected.filter((item) => isImageAsset ? (item.kind === 'image' || item.kind === 'product-image') : item.kind === asset.kind).length;
      const limit = asset.kind === 'image' || asset.kind === 'product-image' ? maxImages : asset.kind === 'inventory-video' ? maxVideos : maxAudios;
      return count >= limit ? current : [...current, asset.id];
    });
 }

  function fileKind(file: File): MediaAsset['kind'] | null {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'inventory-video';
    if (file.type.startsWith('audio/')) return 'audio';
    return null;
  }

  function openProductFolder(folder: typeof productFolders[number]) {
    setActiveProductFolder(folder.key);
    setActiveProductPid(folder.pid);
    setLoadingProductFolder(true);
    setProductFolderImages([]);
    fetch(`/api/workspace/product-images?accountId=${encodeURIComponent(accountId)}&pid=${encodeURIComponent(folder.pid)}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: { folder?: { images?: Array<MediaAsset & { kind?: 'product-image' }>; pid?: string } } }) => {
        if (!payload.success || !payload.data?.folder) return;
        const images = (payload.data.folder.images ?? []).map((asset) => ({ ...asset, kind: 'product-image' as const, shared: true }));
        setProductFolderImages(images);
        setProductImagePool((current) => {
          const pool = new Map(current.map((asset) => [asset.id, asset]));
          for (const asset of images) pool.set(asset.id, asset);
          return [...pool.values()];
        });
      })
      .catch(() => setProductFolderImages([]))
      .finally(() => setLoadingProductFolder(false));
  }

  function selectVideoModel(nextModelId: string) {
    setVideoModelId(nextModelId);
    const nextProvider = nextModelId === 'wan-3'
      ? 'wan-3-nsfw'
      : nextModelId === 'minimax-h3-max'
      ? 'miku-minimax'
      : nextModelId.startsWith('wan3.0-')
      ? 'wan3-video'
      : nextModelId === 'omni-fast-no-water'
        ? 'oairegbox-omni'
      : nextModelId === 'minimax-h3' || nextModelId.startsWith('minimax-h3-')
          ? 'minimax-h3'
        : nextModelId === 'sd2-933-mini'
          ? 'pro666-video'
        : nextModelId === 'quality-v4'
          ? 'quality-v4'
        : nextModelId === 'sd-mini'
          ? 'grok-video'
        : nextModelId === 'grok-video' || nextModelId === 'grok-imagine-video-1.5' || nextModelId === 'grok-imagine-video-1.5-preview'
          ? 'mgrouter-grok-video'
        : 'grok-video';
    if (providers.some((item) => item.id === nextProvider)) setProvider(nextProvider as ProviderId);
  }

  function selectTemplate(id: string) {
    setTemplateId(id);
    const template = promptTemplates.find((item) => item.id === id);
    if (!template) return;
    setPrompt(template.content);
    setOriginalPrompt(template.content);
    setMessage(`已载入模板“${template.name}”`);
  }

  async function savePromptTemplate() {
    const name = promptTemplateName.trim();
    const content = prompt.trim();
    if (!name) { setMessage('请输入模板名称'); return; }
    if (!content) { setMessage('请先输入提示词再保存模板'); return; }
    setSavingPromptTemplate(true); setMessage(null);
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'prompt', name, content, category: mode === 'image' ? 'image' : 'video' }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: PromptAsset; error?: string } | null;
      if (!response.ok || !payload?.success || !payload.data?.id) throw new Error(payload?.error || '提示词模板保存失败');
      const saved = payload.data;
      setPromptTemplates((current) => [...current.filter((item) => item.id !== saved.id), saved]);
      setTemplateId(saved.id);
      setMessage(`提示词模板“${saved.name}”已保存`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提示词模板保存失败');
    } finally {
      setSavingPromptTemplate(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Local files and existing account assets are converted server-side to
    // short-lived HTTPS references (or provider-specific bytes/base64).
    const images: string[] = [...restoredExternalImages];
    const videos: string[] = [...restoredExternalVideos];
    const audios: string[] = [...restoredExternalAudios];
    const selectedMedia = selectedAssetIds.map((id) => selectableAssets.find((asset) => asset.id === id)).filter((asset): asset is MediaAsset => Boolean(asset));
    const selectedImageCount = selectedMedia.filter((asset) => asset.kind === 'image' || asset.kind === 'product-image').length;
    const selectedVideoCount = selectedMedia.filter((asset) => asset.kind === 'inventory-video').length;
    const selectedAudioCount = selectedMedia.filter((asset) => asset.kind === 'audio').length;
    const droppedKinds = droppedFiles.map((file) => fileKind(file));
    if (droppedKinds.some((kind) => !kind)) {
      setMessage('仅支持图片、视频或音频文件');
      return;
    }
    const droppedImageCount = droppedKinds.filter((kind) => kind === 'image').length;
    const droppedVideoCount = droppedKinds.filter((kind) => kind === 'inventory-video').length;
    const droppedAudioCount = droppedKinds.filter((kind) => kind === 'audio').length;
    if (mode !== 'video' && (droppedVideoCount > 0 || droppedAudioCount > 0 || selectedVideoCount > 0 || selectedAudioCount > 0)) {
      setMessage('当前模式只支持图片参考');
      return;
    }
    if (mode !== 'prompt' && (images.length + selectedImageCount + droppedImageCount > maxImages || videos.length + selectedVideoCount + droppedVideoCount > maxVideos || audios.length + selectedAudioCount + droppedAudioCount > maxAudios)) {
      setMessage(`参考素材超出当前模型上限（图片 ${maxImages} / 视频 ${maxVideos} / 音频 ${maxAudios}）`);
      return;
    }
    const validationError = validateProductionInput(mode, {
      prompt,
      referenceImages: images,
      referenceVideos: videos,
      referenceAudios: audios,
      referenceImageCount: selectedImageCount + droppedImageCount,
      referenceVideoCount: selectedVideoCount + droppedVideoCount,
      referenceAudioCount: selectedAudioCount + droppedAudioCount,
      taskNameMode,
      taskName,
      duration: Number(duration),
      aspectRatio,
      resolution,
      provider,
      model: mode === 'image' ? imageModelId : mode === 'video' ? videoModelId : undefined,
    }, capability);
    if (validationError) {
      setMessage(validationError.message === 'task_name_required'
        ? 'Enter a task name when manual naming is selected.'
        : validationError.message === 'task_name_reference_required'
          ? 'Select at least one reference image for automatic naming.'
          : validationError.message);
      return;
    }
    const legacyError = validateGenerationInput(mode, { prompt, referenceImages: images, referenceAudios: audios }, maxImages);
    if (legacyError) { setMessage(legacyError); return; }
    setLoading(true); setMessage(null);
    try {
      let effectiveChildPrompt = childPrompt;
      let effectiveFinalPrompt = finalPrompt;
      const selectedAssetIds = selectedMedia.filter((asset) => asset.kind !== 'product-image').map((asset) => asset.id);
      // Upload all dropped references concurrently so queue submission is not
      // delayed by one network round-trip per file.
      const pendingUploads = droppedFiles.map(async (file): Promise<ProductionAssetSelection> => {
        const form = new FormData();
        form.set('file', file);
        const kind = fileKind(file);
        if (!kind) throw new Error('不支持的素材类型');
        form.set('kind', kind);
        const uploaded = await fetch(`/api/workspace/accounts/${accountId}/files`, { method: 'POST', body: form });
        const payload = await uploaded.json().catch(() => null) as { success?: boolean; data?: { id?: string }; error?: string } | null;
        if (!uploaded.ok || !payload?.success || !payload.data?.id) throw new Error(payload?.error || '本地素材上传失败');
        return { id: payload.data.id, kind };
      });
      const uploadedSelections = await Promise.all(pendingUploads);
      const assetIds = [...selectedAssetIds, ...uploadedSelections.map((selection) => selection.id)];
      const uploadedReferenceAssetIds = uploadedSelections.filter((selection) => selection.kind === 'image').map((selection) => selection.id);
      const uploadedReferenceVideoAssetIds = uploadedSelections.filter((selection) => selection.kind === 'inventory-video').map((selection) => selection.id);
      const uploadedReferenceAudioAssetIds = uploadedSelections.filter((selection) => selection.kind === 'audio').map((selection) => selection.id);
      // Automatic child-prompt generation is now a scheduler phase. The
      // video task is created immediately with `prompting` status; the worker
      // generates the child prompt before submitting the video upstream.
      if (mode === 'video' && promptMode === 'asset-template-child-prompt') {
        effectiveChildPrompt = '';
        effectiveFinalPrompt = '';
      }
      const referenceAssetOrder: ProductionAssetSelection[] = [...selectedMedia, ...uploadedSelections];
      const body = buildGenerationPayload(mode, {
        prompt,
        originalPrompt: originalPrompt || prompt,
        finalPrompt: effectiveFinalPrompt || effectiveChildPrompt || prompt,
        childPrompt: effectiveChildPrompt,
        provider,
        model: mode === 'video' && (provider === 'wan3-video' || provider === 'wan-3-nsfw' || provider === 'grok-video' || provider === 'yuanai-grok-video' || provider === 'mgrouter-grok-video' || provider === 'quality-v4' || provider === 'minimax-h3' || provider === 'pro666-video') ? videoModelId : mode === 'image' ? imageModelId : selectedProvider?.model,
        modelId: mode === 'video' ? videoModelId : undefined,
        supplierId: mode === 'video' ? provider : undefined,
        promptMode,
        promptModel,
        templateId: templateId || undefined,
        suffixEnabled,
        suffix,
        count,
        duration: Number(duration),
        aspectRatio,
        resolution,
        referenceImages: images,
        referenceVideos: videos,
        referenceAudios: audios,
        assetIds,
        referenceAssetIds: [...selectedMedia.filter((asset) => asset.kind === 'image').map((asset) => asset.id), ...uploadedReferenceAssetIds],
        productImageAssetIds: selectedMedia.filter((asset) => asset.kind === 'product-image').map((asset) => asset.id),
        referenceVideoAssetIds: [...selectedMedia.filter((asset) => asset.kind === 'inventory-video').map((asset) => asset.id), ...uploadedReferenceVideoAssetIds],
        referenceAudioAssetIds: [...selectedMedia.filter((asset) => asset.kind === 'audio').map((asset) => asset.id), ...uploadedReferenceAudioAssetIds],
        referenceAssetOrder,
        taskNameMode,
        taskName: taskName.trim() || undefined,
      });
      const endpoint = mode === 'prompt' ? `/api/workspace/accounts/${accountId}/generate-prompt` : mode === 'image' ? `/api/workspace/accounts/${accountId}/generate-image` : `/api/workspace/accounts/${accountId}/generate-video`;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: { prompt?: string; taskId?: string; execution?: string; model?: string; limit?: number; used?: number; remaining?: number; requested?: number }; error?: string } | null;
      // The daily-quota rejection carries the operator's actual usage, so it is
      // reported with those numbers instead of a generic failure code.
      if (payload?.error === 'daily_model_quota_exceeded' && payload.data) {
        const { model: quotaModel, limit, used, remaining, requested } = payload.data;
        setMessage(`今日 ${quotaModel} 额度已用完：上限 ${limit} 个，已成功 ${used} 个，剩余 ${remaining} 个，本次提交 ${requested} 个。请减少数量或明天再试。`);
        return;
      }
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '请求失败');
      setMessage(mode === 'prompt' ? `已生成提示词：${payload.data?.prompt ?? ''}` : `任务已创建：${payload.data?.taskId ?? 'queued'} · ${payload.data?.execution ?? 'mock'}`);
      // Keep the complete production configuration after submission so the
      // operator can immediately submit another task with the same prompt,
      // references and parameters. Local files intentionally remain selected;
      // the next submit will upload them again as a new task input.
    } catch (error) {
      setMessage(formatProductionError(error instanceof Error ? error.message : '请求失败', promptModel));
    } finally { setLoading(false); }
  }

  const promptTemplateTools = mode === 'image' ? <div className="prompt-template-toolbar"><label>选择提示词模板<select className="select" value={templateId} onChange={(event) => selectTemplate(event.target.value)}><option value="">不使用模板</option>{promptTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}{item.accountName ? ` · ${item.accountName}` : ''}</option>)}</select></label><label>模板名称<input className="select" value={promptTemplateName} onChange={(event) => setPromptTemplateName(event.target.value)} placeholder="例如：白底商品图" /></label><button type="button" className="ghost-button" onClick={() => void savePromptTemplate()} disabled={savingPromptTemplate || !prompt.trim()}>{savingPromptTemplate ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} 保存提示词</button></div> : null;
   return <form className="production-form" data-reference-images={maxImages} data-reference-videos={maxVideos} data-reference-audios={maxAudios} onSubmit={submit}>
    {mode !== 'prompt' && <div className="task-naming-row form-row" role="group" aria-label="Task naming">
      <label>Task naming<select className="select" value={taskNameMode} onChange={(event) => setTaskNameMode(event.target.value as TaskNameMode)}>
        <option value="auto">Automatic (first reference image)</option>
        <option value="manual">Manual</option>
      </select></label>
      {taskNameMode === 'manual' && <label>Task name<input className="select" value={taskName} onChange={(event) => setTaskName(event.target.value)} maxLength={120} placeholder="Enter a task name" /></label>}
      {taskNameMode === 'auto' && <small className="field-help">Automatic naming requires at least one reference image.</small>}
    </div>}
     {mode === 'image' && imageModelOptions.length > 0 && <label className="form-row">Model<select className="select" value={imageModelId} onChange={(event) => setImageModelId(event.target.value)}>{imageModelOptions.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>}
    {mode === 'image' && <label className="form-row">生成数量<select className="select" value={count} onChange={(event) => setCount(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value} 条</option>)}</select></label>}
    {mode !== 'prompt' && <div className="routing-section"><div className="production-fieldset-title">模型与生产参数</div><div className="routing-label">{mode === 'video' ? '视频模型' : '图片模型'}</div><div className="routing-cards">{(mode === 'video' ? VIDEO_ROUTING_CARDS : IMAGE_ROUTING_CARDS).map((card) => { const active = mode === 'video' ? (card.id === 'grok' ? card.providers.includes(provider) : card.id === videoModelId) : card.id === selectedImageModel; const enabled = card.providers.length > 0 && card.providers.some((item) => providers.some((providerItem) => providerItem.id === item)); return <button key={card.id} type="button" className={`routing-card ${active ? 'active' : ''}`} disabled={!enabled} onClick={() => { if (mode === 'video') selectVideoModel(card.id === 'grok' ? 'grok-imagine-video-1.5（按次）' : card.id); else { const next = providers.find((item) => card.providers.includes(item.id)); if (next) setProvider(next.id); } }}><strong>{card.label}</strong><span>{enabled ? `${card.providers.length} 个供应商` : '待接入'}</span></button>; })}</div><div className="routing-provider-row">{mode === 'video' && <label>模型<select className="select" value={videoModelId} onChange={(event) => selectVideoModel(event.target.value)}>{videoModelsForProvider(provider, videoModelId).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}<label>供应商<select className="select" value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)}>{(mode === 'video' ? providerOptionsForVideoModel(providers, videoModelId) : providers.filter((item) => IMAGE_ROUTING_CARDS.find((card) => card.id === selectedImageModel)?.providers.includes(item.id))).map((item) => <option value={item.id} key={item.id}>{item.name}{mode === 'video' ? ` · ${item.supports.referenceImages} 图` : ''}</option>)}</select></label></div><div className="production-parameter-row"> <label>比例<select className="select" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{ratios.map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label><label>{mode === 'video' ? '时长' : '分辨率'}<select className="select" value={mode === 'video' ? duration : resolution} onChange={(event) => mode === 'video' ? setDuration(event.target.value) : setResolution(event.target.value)}>{mode === 'video' ? durationOptions.map((value) => <option value={value} key={value}>{value} 秒</option>) : resolutionOptions.map((value) => <option value={value} key={value}>{String(value).toUpperCase()}</option>)}</select></label>{mode === 'video' && <label>分辨率<select className="select" value={resolution} onChange={(event) => setResolution(event.target.value)}>{resolutionOptions.map((value) => <option value={value} key={value}>{String(value).toUpperCase()}</option>)}</select></label>}{mode === 'video' && <label>生成数量<select className="select" value={count} onChange={(event) => setCount(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value} 条</option>)}</select></label>}</div></div>}
    {mode === 'video' && <div className="prompt-mode-bar" role="group" aria-label="提示词模式"><button type="button" className={`prompt-mode-button ${promptMode === 'manual' ? 'active' : ''}`} onClick={() => { setPromptMode('manual'); setChildPrompt(''); setFinalPrompt(''); }}>手写提示词</button><button type="button" className={`prompt-mode-button ${promptMode === 'asset-template-child-prompt' ? 'active' : ''}`} onClick={() => { setPromptMode('asset-template-child-prompt'); setChildPrompt(''); setFinalPrompt(''); }}>自动生成子提示词</button></div>}
     <label>{mode === 'prompt' ? '商品 / 提示词上下文' : mode === 'image' ? '图片生成提示词' : promptMode === 'manual' ? '视频提示词' : '商品 / 场景上下文'}<textarea className="select production-prompt-textarea" rows={8} value={prompt} onChange={(event) => { setPrompt(event.target.value); if (!originalPrompt) setOriginalPrompt(event.target.value); }} placeholder={mode === 'prompt' ? '输入商品标题、卖点和目标人群，生成子提示词' : promptMode === 'manual' ? '直接写入可提交给视频模型的完整提示词' : '输入商品卖点、场景和目标人群，自动生成视频子提示词'} /></label>
     {promptTemplateTools}
    {mode === 'video' && <ProductSummaryUploader accountId={accountId} referenceName={selectedReferenceImageName} />}
    {mode === 'video' && promptMode === 'manual' && <div className="form-row"><label>账号资产提示词模板<select className="select" value={templateId} onChange={(event) => selectTemplate(event.target.value)}><option value="">不使用模板</option>{promptTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}{item.accountName ? ` · ${item.accountName}` : ''}</option>)}</select><small className="field-help">仅显示当前工作区账号的提示词模板，载入后仍可继续手写修改。</small></label><label>模板名称<input className="select" value={promptTemplateName} onChange={(event) => setPromptTemplateName(event.target.value)} placeholder="例如：卡点视频" /><small className="field-help">手写好提示词后可直接存为当前账号的视频模板。</small></label><button type="button" className="ghost-button" onClick={() => void savePromptTemplate()} disabled={savingPromptTemplate || !prompt.trim()}>{savingPromptTemplate ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} 保存提示词</button></div>}
    {mode === 'video' && promptMode === 'asset-template-child-prompt' && <div className="form-row"><label>账号资产提示词模板<select className="select" value={templateId} onChange={(event) => selectTemplate(event.target.value)}><option value="">请选择模板</option>{promptTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>子提示词模型<select className="select" value={promptModel} onChange={(event) => setPromptModel(event.target.value)}><option value="pomoai-gpt">PomoAI GPT-5.5（仅 PomoAI 内部模型自动退避）</option>{(promptProviders.find((item) => item.id === 'pomoai-gpt-prompt')?.promptModelOptions ?? []).map((model) => <option key={`pomoai:${model}`} value={`pomoai:${model}`}>PomoAI · {model}</option>)}<option value="oairegbox-gpt">OAIRegBox GPT-5.5</option><option value="bigsnake">BigSnake GPT-5.5</option><option value="gpt-2999">GPT-2999</option><option value="gemini-2.5-flash">Gemini 2.5 Flash</option></select></label><small className="field-help">PomoAI 只会在自身可用的对话模型之间自动退避；OAIRegBox、BigSnake 等供应商需要单独选择。</small></div>}
    {mode === 'video' && promptMode === 'manual' && <div className="prompt-manual-note">手写模式将直接使用上方提示词提交生产；切换到自动模式后，系统会先调用提示词模型生成子提示词，再加入生产队列。</div>}
    {mode !== 'prompt' && <div className="reference-picker-buttons">
      {maxImages > 0 && <button type="button" className="ghost-button" onClick={() => { setAssetPickerKind('image'); setAssetPickerTab('material'); setAssetPickerOpen(true); }}>选择参考图 <span>{selectedImageCountForDisplay}/{maxImages}</span></button>}
      {maxVideos > 0 && <button type="button" className="ghost-button" onClick={() => { setAssetPickerKind('inventory-video'); setAssetPickerTab('material'); setAssetPickerOpen(true); }}>选择参考视频 <span>{selectedVideoCountForDisplay}/{maxVideos}</span></button>}
      {maxAudios > 0 && <button type="button" className="ghost-button" onClick={() => { setAssetPickerKind('audio'); setAssetPickerTab('material'); setAssetPickerOpen(true); }}>选择参考音频 <span>{selectedAudioCountForDisplay}/{maxAudios}</span></button>}
      <small className="field-help">仅展示当前模型支持的参考素材类型；素材图按账号隔离，商品图来自共享商品库。</small>
    </div>}
    {assetPickerOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAssetPickerOpen(false); }}>
      <section className="modal-card asset-picker-modal" role="dialog" aria-modal="true" aria-labelledby="asset-picker-title">
        <div className="panel-header"><div><h2 id="asset-picker-title" className="panel-title">选择{assetPickerKind === 'image' ? '参考图' : assetPickerKind === 'inventory-video' ? '参考视频' : '参考音频'}</h2><div className="panel-meta">已选择 {assetPickerKind === 'image' ? selectedImageCountForDisplay : assetPickerKind === 'inventory-video' ? selectedVideoCountForDisplay : selectedAudioCountForDisplay} 项</div></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setAssetPickerOpen(false)}><X size={15} /></button></div>
        {assetPickerKind === 'image' && <div className="asset-picker-tabs"><button type="button" className={assetPickerTab === 'material' ? 'active' : ''} onClick={() => { setAssetPickerTab('material'); setActiveProductPid(null); }}>素材图片</button><button type="button" className={assetPickerTab === 'product' ? 'active' : ''} onClick={() => { setAssetPickerTab('product'); setActiveProductPid(null); }}>商品图片</button></div>}
          {assetPickerKind === 'image' && assetPickerTab === 'product' && !activeProductPid && <ProductGalleryImporter accountId={accountId} onImported={refreshProductAssets} />}
          <label className="asset-picker-search"><Search size={15} /><span className="sr-only">搜索素材</span><input value={assetPickerQuery} onChange={(event) => setAssetPickerQuery(event.target.value)} placeholder="搜索文件名或 PID" /></label>
          {assetPickerKind === 'image' && assetPickerTab === 'product' && !activeProductPid && <div className="asset-reference-grid asset-picker-grid product-folder-picker-grid">{productFolders.filter((folder) => !assetPickerQuery.trim() || folder.pid.toLowerCase().includes(assetPickerQuery.trim().toLowerCase())).map((folder) => <button type="button" className="asset-reference-option asset-picker-option product-folder-picker-option" key={folder.key} onClick={() => openProductFolder(folder)}><div className="asset-picker-image-preview">{folder.cover ? <AssetPickerPreview accountId={accountId} asset={folder.cover} /> : <ImageIcon size={22} />}</div><span className="asset-picker-name">PID {folder.pid}</span><small>{folder.imageCount ?? folder.images?.length ?? 0} 张商品图片</small></button>)}{productFolders.length === 0 && <div className="asset-picker-empty">还没有导入商品图片文件夹</div>}</div>}
          {assetPickerKind === 'image' && assetPickerTab === 'product' && activeProductPid && <div className="asset-reference-grid asset-picker-grid product-folder-image-grid"><div className="asset-picker-folder-banner"><button type="button" className="ghost-button asset-picker-back" onClick={() => { setActiveProductPid(null); setActiveProductFolder(null); setProductFolderImages([]); }}>返回商品文件夹</button><div><strong>PID {visibleProductFolder?.pid ?? activeProductPid}</strong><small>{loadingProductFolder ? '加载文件夹中…' : `${(productFolderImages.length || visibleProductFolder?.imageCount || 0)} 张商品图片`}</small></div></div>{(productFolderImages.length ? productFolderImages : visibleProductFolder?.images ?? []).map((asset) => <button type="button" key={asset.id} className={`asset-reference-option asset-picker-option product-folder-image-option ${selectedProductImageIds.includes(asset.id) ? 'is-selected' : ''}`} onClick={() => { toggleAsset(asset); }}><AssetPickerPreview accountId={accountId} asset={asset} /><span className="asset-picker-name">{asset.name}</span><small>{asset.shared ? `商品图 · ${asset.pid ?? ''}` : '商品图 · 当前账号'}</small></button>)}{loadingProductFolder && <div className="asset-picker-empty">正在加载文件夹图片…</div>}</div>}
          {(assetPickerKind !== 'image' || assetPickerTab !== 'product') && <div className="asset-reference-grid asset-picker-grid">{pickerAssets.map((asset) => {
            const selected = selectedAssetIds.includes(asset.id);
            const order = selectedAssetIds.indexOf(asset.id);
            return <label key={asset.id} className={`asset-reference-option asset-picker-option ${selected ? 'is-selected' : ''} ${asset.shared ? 'shared-asset' : ''}`}>
              {assetPickerKind === 'image' ? <AssetPickerPreview accountId={accountId} asset={asset} /> : <div className="asset-picker-media-placeholder"><ImageIcon size={22} /></div>}
             {order >= 0 && <span className="asset-picker-order" aria-label={`第 ${order + 1} 张参考素材`}>{order + 1}</span>}
             <input type="checkbox" checked={selected} onChange={() => toggleAsset(asset)} />
           <span className="asset-picker-name">{asset.name}</span>
           <small>{asset.shared ? `商品图${asset.pid ? ` · ${asset.pid}` : ''} · 全运营共享` : assetPickerKind === 'inventory-video' ? '库存视频 · 当前账号' : assetPickerKind === 'audio' ? '音频 · 当前账号' : '素材图 · 当前账号'}</small>
         </label>;
         })}{pickerAssets.length === 0 && <div className="asset-picker-empty">没有匹配的素材</div>}</div>}
        <div className="modal-actions"><button type="button" className="ghost-button" onClick={() => { const clearedKinds: Array<MediaAsset['kind']> = assetPickerKind === 'image' ? ['image', 'product-image'] : [assetPickerKind]; setSelectedAssetIds((current) => current.filter((id) => { const asset = selectableAssets.find((item) => item.id === id); return asset ? !clearedKinds.includes(asset.kind) : false; })); }}>清除已选</button><button type="button" className="ghost-button" onClick={() => setAssetPickerOpen(false)}>完成选择</button></div>
      </section>
    </div>}
    {mode !== 'prompt' && (maxImages > 0 || maxVideos > 0 || maxAudios > 0) && <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); setDroppedFiles((current) => [...current, ...Array.from(event.dataTransfer.files)]); }}><UploadIcon /><div><strong>拖入或选择本地参考素材</strong><span>{mode === 'image' ? `支持图片，最多 ${maxImages} 张` : `支持图片、视频、音频；图片 ${maxImages} / 视频 ${maxVideos} / 音频 ${maxAudios}`}</span></div><input type="file" multiple accept={acceptedFileTypes} onChange={(event) => setDroppedFiles((current) => [...current, ...Array.from(event.target.files ?? [])])} /></div>}
    {droppedFiles.length > 0 && <div className="dropzone-files">{droppedFiles.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}</span>)}<button type="button" className="ghost-button" onClick={() => setDroppedFiles([])}>清空</button></div>}
    {mode === 'video' && <div className="suffix-setting"><label><input type="checkbox" checked={suffixEnabled} onChange={(event) => setSuffixEnabled(event.target.checked)} /> 追加统一后缀</label><textarea className="select" rows={2} value={suffix} onChange={(event) => setSuffix(event.target.value)} placeholder="可选，来自 10000 的统一后缀" /></div>}
    {selectedProvider?.id === 'mgrouter-grok-video' && <div className="provider-hint">MGRouter 视频会按音频数量补齐 &lt;AUDIO_0&gt; / &lt;AUDIO_1&gt; 占位符。</div>}
    {selectedProvider?.id === 'wan3-video' && <div className="provider-hint">Wan 3 使用 media.audio / reference_image / reference_video 多媒体契约。</div>}
     {selectedProvider?.id === 'yuanai-image' && <div className="provider-hint">YuanAI Image 支持 1K / 2K / 4K；选择 4K 时会按 4096×4096 参数提交。</div>}
    {message && <div className="production-result" role="status">{message}</div>}
    <button className="primary-button" type="submit" disabled={loading}>{loading ? <LoaderCircle className="spin" size={14} /> : mode === 'image' ? <ImageIcon size={14} /> : mode === 'prompt' ? <WandSparkles size={14} /> : <Film size={14} />}{loading ? '提交中…' : mode === 'prompt' ? '生成提示词' : mode === 'image' ? '创建图片任务' : '加入生产队列'}</button>
  </form>;
}

function productPidFromAssetId(assetId: string): string | undefined {
  const parts = assetId.split(':');
  // Product asset IDs are product-image:<account>:<date>:<pid>:<file>.
  // Account and file segments are validated when imported, so a colon split
  // is sufficient and avoids exposing filesystem paths to the client.
  return parts[0] === 'product-image' && parts.length >= 5 && parts[3] ? parts[3] : undefined;
}

function getVideoCapabilityByKey(key: string): VideoCapability | undefined {
  const [supplier, model] = key.split(':');
  try { return getVideoCapability(supplier, model); } catch { return undefined; }
}

function AssetPickerPreview({ accountId, asset }: { accountId: string; asset: MediaAsset }) {
  const [failed, setFailed] = useState(false);
  const src = asset.shared || asset.kind === 'product-image'
    ? asset.coverUrl || asset.url || `/api/workspace/product-images/preview?assetId=${encodeURIComponent(asset.id)}`
    : `/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(asset.id)}`;
  if (failed || !src) return <div className="asset-picker-image-preview asset-picker-image-placeholder"><ImageIcon size={24} /><span>暂无预览</span></div>;
  return <div className="asset-picker-image-preview"><img src={src} alt={`${asset.name} 预览`} loading="lazy" onError={() => setFailed(true)} /></div>;
}

function ProductGalleryImporter({ accountId, onImported }: { accountId: string; onImported: () => Promise<void> | void }) {
  const [query, setQuery] = useState('');
  const [pidFileName, setPidFileName] = useState('');
  const [pidFilePids, setPidFilePids] = useState<string[]>([]);
  const [results, setResults] = useState<Array<{ pid: string; title?: string; description?: string; coverUrl?: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');
  async function readPidFile(file: File): Promise<string[]> {
    const extension = file.name.toLowerCase().split('.').pop();
    if (extension === 'txt') return parsePidListText(await file.text());
    if (extension !== 'xlsx' && extension !== 'xls') throw new Error('PID 文件仅支持 .xlsx、.xls 或 .txt');
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', dense: true, raw: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false }) as unknown[][];
    return parsePidRows(rows);
  }
  async function handlePidFile(file: File | undefined) {
    if (!file) return;
    try {
      const pids = await readPidFile(file);
      setPidFileName(file.name); setPidFilePids(pids); setQuery(pids.join(', '));
      setMessage(pids.length ? `已读取 ${pids.length} 个 PID` : '文件中没有找到有效 PID');
    } catch (error) { setPidFileName(''); setPidFilePids([]); setMessage(error instanceof Error ? error.message : 'PID 文件读取失败'); }
  }
  async function search() {
    const pids = [...new Set((pidFilePids.length ? pidFilePids : parsePidListText(query)))].slice(0, 100);
    if (!pids.length) { setMessage('请输入 PID 或选择 PID 文件'); return; }
    setSearching(true); setMessage('');
    try {
      const payloads: PromiseSettledResult<typeof results>[] = [];
      for (let index = 0; index < pids.length; index += 8) {
        const batch = await Promise.allSettled(pids.slice(index, index + 8).map(async (pid) => {
          const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images?source=8765&query=${encodeURIComponent(pid)}`, { cache: 'no-store' });
          const payload = await response.json() as { success?: boolean; data?: { gallery?: typeof results }; error?: string };
          if (!response.ok || !payload.success) throw new Error(payload.error || '8765 图库查询失败');
          return payload.data?.gallery ?? [];
        }));
        payloads.push(...batch);
      }
      const fulfilled = payloads.filter((result): result is PromiseFulfilledResult<NonNullable<typeof results>> => result.status === 'fulfilled');
      const rejected = payloads.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const merged = normalizeProductGalleryItems(fulfilled.flatMap((result) => result.value) as any);
      setResults(merged as typeof results); setSelected([]);
      // 8765 answers an unknown PID with HTTP 200 and an empty list. That is a
      // “not in the gallery” answer, not a service failure, so only a rejected
      // request may surface as an error.
      if (rejected.length) {
        const reason = rejected[0].reason;
        const detail = reason instanceof Error ? reason.message : String(reason ?? '');
        setMessage(merged.length
          ? `已展示 ${merged.length} 个结果；${rejected.length} 个 PID 查询失败（${detail}）`
          : `8765 图库查询失败：${detail}`);
      } else if (!merged.length) {
        setMessage(`8765 图库里没有找到这 ${pids.length} 个 PID，请确认 PID 是否正确`);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : '8765 图库查询失败'); }
    finally { setSearching(false); }
  }
  async function importSelected() {
    if (!selected.length) return;
    setImporting(true); setMessage('');
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pids: selected }) });
      const payload = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || '商品图片导入失败');
      setSelected([]); setMessage(`已导入 ${selected.length} 个 PID 文件夹`); await onImported();
    } catch (error) { setMessage(error instanceof Error ? error.message : '商品图片导入失败'); }
    finally { setImporting(false); }
  }
  return <div className="product-gallery-importer">
    <div className="product-image-search" role="search"><label className="sr-only" htmlFor="production-product-pid-query">搜索 8765 PID</label><input id="production-product-pid-query" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} placeholder="搜索 8765 PID、标题或描述" /><button type="button" className="ghost-button" disabled={searching || importing} onClick={() => void search()}><Search size={14} /> {searching ? '查询中…' : '查询'}</button><button type="button" className="primary-button" onClick={() => void importSelected()} disabled={importing || !selected.length}><Download size={14} /> {importing ? '导入中…' : `导入选中 (${selected.length})`}</button></div>
    <label className="product-pid-file-dropzone compact" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void handlePidFile(event.dataTransfer.files?.[0]); }}><input type="file" accept=".xlsx,.xls,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/plain" onChange={(event) => { void handlePidFile(event.target.files?.[0]); event.currentTarget.value = ''; }} /><span><Download size={14} />拖入或选择 PID 文件</span><small>Excel 第一列或 TXT 每行一个 PID{pidFileName ? ` · ${pidFileName}（${pidFilePids.length} 个）` : ''}</small></label>
    {message && <small role="status" className="field-help">{message}</small>}
    {results.length > 0 && <div className="product-gallery-import-results">{results.map((item) => <label key={item.pid} className="product-gallery-import-card"><input type="checkbox" checked={selected.includes(item.pid)} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, item.pid])] : current.filter((pid) => pid !== item.pid))} />{item.coverUrl ? <img src={item.coverUrl} alt={`${item.pid} 封面`} /> : <span className="product-cover-placeholder"><ImageIcon size={20} /></span>}<span><strong>{item.pid}</strong><small>{item.title || item.description || '8765 PID 文件夹'}</small></span></label>)}</div>}
  </div>;
}

function ProductSummaryUploader({ accountId, compact = false, referenceName = '' }: { accountId: string; compact?: boolean; referenceName?: string }) {
  const [info, setInfo] = useState<{ fileName: string | null; rowCount: number; source: string; match?: { pid?: string; title?: string; description?: string } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const query = referenceName.trim() ? `?referenceName=${encodeURIComponent(referenceName.trim())}` : '';
    fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/product-summary${query}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: typeof info }) => {
        if (!cancelled && payload.success && payload.data) setInfo(payload.data);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [accountId, referenceName]);

  async function upload(file: File) {
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      setMessage('仅支持 .xlsx 或 .xls 文件');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/product-summary`, { method: 'POST', body: form });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: typeof info; error?: string } | null;
      if (!response.ok || !payload?.success || !payload.data) throw new Error(payload?.error || 'Excel 上传失败');
      setInfo(payload.data);
      setMessage(`已读取 ${payload.data.rowCount} 条商品数据`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Excel 上传失败');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const matched = info?.match?.pid
    ? { pid: info.match.pid }
    : null;

  return (
    <div
      className={`product-summary-uploader ${compact ? 'compact' : ''} ${dragging ? 'dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void upload(file);
      }}
    >
      <div>
        <strong>上传 Excel 商品汇总表</strong>
        <small>拖入或选择 .xlsx/.xls 文件，首行需包含 pid 列；系统会按参考图的 PID 自动匹配标题和描述。</small>
        {info?.fileName && <small>当前表：<span className={info.source === 'default' ? 'product-summary-default' : ''}>{info.fileName}</span> · {info.rowCount} 条</small>}
        {referenceName && <small>{matched ? `匹配到 PID ${matched.pid}` : `未匹配到：${referenceName}（请确认汇总表包含该 PID）`}</small>}
        {message && <small role="status">{message}</small>}
      </div>
      <button type="button" className="ghost-button" onClick={() => inputRef.current?.click()} disabled={busy}>{busy ? '上传中…' : '选择 Excel'}</button>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
function providerModelId(provider: ProviderId): string | undefined {
  const key = VIDEO_CAPABILITY_KEYS[provider];
  return key?.split(':').slice(1).join(':');
}

export function providersForVideoModel(providers: ReadonlyArray<ProviderCatalogEntry>, modelId: string) {
  if (modelId === 'wan-3') return providers.filter((item) => item.id === 'wan-3-nsfw');
  if (modelId === 'minimax-h3-max') return providers.filter((item) => item.id === 'miku-minimax');
  if (modelId.startsWith('wan3.0-')) return providers.filter((item) => item.id === 'wan3-video');
  if (modelId === 'quality-v4') {
    return providers.filter((item) => item.id === 'quality-v4');
  }
  if (modelId === 'sd-mini') return providers.filter((item) => item.id === 'grok-video');
  if (modelId === 'omni-fast-no-water') return providers.filter((item) => item.id === 'oairegbox-omni');
  if (modelId === 'minimax-h3' || modelId.startsWith('minimax-h3-')) return providers.filter((item) => item.id === 'minimax-h3');
  if (modelId === 'sd2-933-mini') return providers.filter((item) => item.id === 'pro666-video');
  if (modelId === 'grok-video' || modelId === 'grok-imagine-video-1.5' || modelId === 'grok-imagine-video-1.5-preview') {
    return providers.filter((item) => item.id === 'grok-video' || item.id === 'mgrouter-grok-video' || item.id === 'yuanai-grok-video');
  }
  if (modelId === 'grok-imagine-video-1.5（按次）' || modelId === 'grok-video-1.5（按秒）' || modelId === 'grok-video-1.5') {
    return providers.filter((item) => item.id === 'grok-video');
  }
  return providers.filter((item) => item.id === 'grok-video' || item.id === 'mgrouter-grok-video' || item.id === 'yuanai-grok-video');
}

/** Supplier choices shown beside the model selector. Grok can be routed via
 * either snumom or MGRouter, so both remain selectable before the model id is
 * normalized by the provider effect. Other models stay strictly isolated. */
export function providerOptionsForVideoModel(providers: ReadonlyArray<ProviderCatalogEntry>, modelId: string) {
  if (modelId === 'grok-video' || modelId === 'grok-imagine-video-1.5' || modelId === 'grok-imagine-video-1.5-preview' || modelId === 'grok-imagine-video-1.5（按次）' || modelId === 'grok-video-1.5（按秒）' || modelId === 'grok-video-1.5') {
    return providers.filter((item) => item.id === 'grok-video' || item.id === 'mgrouter-grok-video' || item.id === 'yuanai-grok-video');
  }
  return providersForVideoModel(providers, modelId);
}

/** Return only model ids understood by the currently selected supplier. */
export function videoModelsForProvider(provider: ProviderId, currentModelId?: string): ReadonlyArray<{ id: string; label: string }> {
  // Keep the historical `grok-video` alias out of the selector; it remains
  // accepted by the API/router for restored tasks but MGRouter's live catalog
  // uses the two canonical ids below.
  if (provider === 'mgrouter-grok-video') return VIDEO_MODELS.filter((item) => item.id === 'grok-imagine-video-1.5' || item.id === 'grok-imagine-video-1.5-preview');
  if (provider === 'yuanai-grok-video') return VIDEO_MODELS.filter((item) => item.id === 'grok-imagine-video-1.5-preview');
  if (provider === 'grok-video') return VIDEO_MODELS.filter((item) => item.id === 'grok-imagine-video-1.5（按次）' || item.id === 'grok-video-1.5（按秒）');
  if (provider === 'quality-v4') return VIDEO_MODELS.filter((item) => item.id === 'quality-v4');
  if (provider === 'oairegbox-omni') return VIDEO_MODELS.filter((item) => item.id === 'omni-fast-no-water');
  if (provider === 'minimax-h3') {
    const legacy = currentModelId && (currentModelId === 'minimax-h3-r2v' || currentModelId === 'minimax-h3-t2v')
      ? VIDEO_MODELS.find((item) => item.id === currentModelId)
      : undefined;
    return [VIDEO_MODELS.find((item) => item.id === 'minimax-h3'), legacy].filter((item): item is { id: string; label: string } => Boolean(item));
  }
  if (provider === 'miku-minimax') return VIDEO_MODELS.filter((item) => item.id === 'minimax-h3-max');
  if (provider === 'pro666-video') return VIDEO_MODELS.filter((item) => item.id === 'sd2-933-mini');
  if (provider === 'wan3-video') {
    const legacy = currentModelId && currentModelId.startsWith('wan3.0-prime-')
      ? VIDEO_MODELS.find((item) => item.id === currentModelId)
      : undefined;
    return [VIDEO_MODELS.find((item) => item.id === 'wan3.0-r2v'), legacy].filter((item): item is { id: string; label: string } => Boolean(item));
  }
  if (provider === 'wan-3-nsfw') return VIDEO_MODELS.filter((item) => item.id === 'wan-3');
  return VIDEO_MODELS.filter((item) => item.id !== 'sd-mini' && item.id !== 'grok-video');
}

function UploadIcon() { return <span className="dropzone-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 14v5h14v-5" /></svg></span>; }

export function promptProviderLabel(promptModel: string): string {
  const normalized = promptModel.trim().toLowerCase();
  if (normalized === 'pomoai-gpt' || normalized === 'pomoai-gpt-prompt') return 'PomoAI GPT-5.5（自动退避）';
  if (normalized.startsWith('pomoai:')) return `PomoAI ${normalized.slice('pomoai:'.length) || 'GPT'}`;
  if (normalized === 'oairegbox-gpt' || normalized === 'oairegbox-gpt-prompt') return 'OAIRegBox GPT-5.5';
  if (normalized === 'bigsnake' || normalized.startsWith('bigsnake:')) return 'BigSnake';
  if (normalized === 'gpt-2999' || /^gpt[-_]/.test(normalized)) return 'GPT-2999';
  if (/^gemini[-_]/.test(normalized)) return 'Gemini';
  return '当前提示词模型';
}

function formatProductionError(code: string, promptModel = ''): string {
  if (code === 'prompt_provider_failed') {
    return `提示词模型请求失败（${promptProviderLabel(promptModel)}）：请检查当前选择的提示词模型、API Key、模型名称和网络状态后重试`;
  }
  const messages: Record<string, string> = {
    provider_401: '供应商鉴权失败：API Key 无效、已过期或没有权限，请更新 Key 后重试',
    provider_403: '供应商拒绝访问：当前 API Key 没有调用权限，请检查账户权限',
    provider_404: '供应商接口或模型不存在，请检查 Base URL 和模型配置',
    provider_408: '供应商响应超时，请稍后重试',
    provider_429: '供应商请求过于频繁或额度不足，请稍后重试或检查余额',
    provider_500: '供应商服务内部错误，请稍后重试',
    provider_not_configured: '该供应商尚未配置有效密钥，请在 .env.local 中配置后重试',
    daily_model_quota_exceeded: '今日该模型的生成额度已用完（每人每天最多 50 个成功任务），请明天再试',
    provider_unauthorized: '供应商凭证无效或已过期，请更新供应商密钥',
    provider_model_unavailable: '供应商当前没有可用的模型通道，请稍后重试或联系供应商',
    provider_upstream_failed: '供应商上游生成失败，任务未产出内容（如已预扣费请以供应商账单为准）',
    provider_invalid_request: '供应商拒绝了请求参数，请检查模型能力对应的时长、比例和分辨率',
    provider_content_policy: '供应商内容审核拒绝了本次请求，请修改提示词后重试',
    provider_reference_rejected: '供应商内容审核拒绝了参考图，请更换参考图后重试',
    provider_response_too_large: '供应商返回内容过大，常见于 4K 图片结果；请重试或暂时选择较低分辨率',
    mgrouter_reference_audio_unsupported: 'MGRouter 当前仅支持内置 voice_id，不支持上传音频文件；请移除音频参考后重试',
    image_provider_failed: '图片供应商请求失败，请查看供应商状态或密钥配置',
    provider_request_failed: '供应商请求失败，请稍后重试',
  };
  return messages[code] || formatProviderError(code) || code;
}
