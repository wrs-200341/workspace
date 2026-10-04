'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Check,
  Download,
  FileImage,
  FileText,
  Film,
  FolderOpen,
  Loader2,
  Pencil,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { AssetKind, PromptAssetCategory, WorkspaceAsset } from '@/lib/workspace/assetStore';
import { PromptTemplateEditor } from './PromptTemplateEditor';
import ReviewZoomableMedia from './ReviewZoomableMedia';
import { matchesAssetPidPrefix } from './assetPidSearch';

type Props = {
  accountId: string;
  section: AssetKind;
  initialAssets: WorkspaceAsset[];
  promptTab?: PromptAssetCategory;
  readOnly?: boolean;
};

type UploadState = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
};

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff'];
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'csv'];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_PROMPT_FILE_SIZE = 2 * 1024 * 1024;
const ASSET_PAGE_SIZE = 48;

function formatBytes(size?: number): string {
  if (!size) return '本地资产';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function assetUrl(accountId: string, assetId: string, download = false): string {
  return `/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(assetId)}${download ? '?download=1' : ''}`;
}

function fileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

function downloadName(asset: WorkspaceAsset): string {
  const cleaned = asset.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'asset';
  if (cleaned.includes('.')) return cleaned;
  const extensionByMime: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  };
  const extension = asset.mimeType ? extensionByMime[asset.mimeType.toLowerCase()] : undefined;
  return extension ? `${cleaned}.${extension}` : cleaned;
}

function isSupportedFile(file: File, section: AssetKind): boolean {
  if (file.size <= 0 || file.size > (section === 'prompt' ? MAX_PROMPT_FILE_SIZE : MAX_FILE_SIZE)) return false;
  const extension = fileExtension(file.name);
  if (section === 'prompt') return TEXT_EXTENSIONS.includes(extension) || file.type.startsWith('text/');
  if (section === 'image') return extension !== 'svg' && file.type !== 'image/svg+xml' && (file.type.startsWith('image/') || IMAGE_EXTENSIONS.includes(extension));
  if (section === 'inventory-video') return file.type.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'].includes(extension);
  return file.type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm'].includes(extension);
}

function acceptFor(section: AssetKind): string {
  if (section === 'prompt') return '.txt,.md,.markdown,.json,.csv,text/*';
  if (section === 'image') return 'image/*';
  if (section === 'inventory-video') return 'video/*';
  return 'audio/*';
}

function sectionLabel(section: AssetKind): string {
  return section === 'prompt' ? '提示词' : section === 'image' ? '图片' : section === 'inventory-video' ? '库存视频' : '音频';
}

function iconFor(section: AssetKind) {
  if (section === 'prompt') return FileText;
  if (section === 'image') return FileImage;
  if (section === 'inventory-video') return Film;
  return AudioLines;
}

export function AccountAssetLibrary({ accountId, section, initialAssets, promptTab, readOnly = false }: Props) {
  const [assets, setAssets] = useState<WorkspaceAsset[]>(initialAssets);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  // Inventory videos are split into published/unpublished so a clip that has
  // already gone out does not sit mixed in with the ones still to be used.
  const [publishFilter, setPublishFilter] = useState<'unpublished' | 'published'>('unpublished');
  const [editingName, setEditingName] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(ASSET_PAGE_SIZE);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [viewerAsset, setViewerAsset] = useState<WorkspaceAsset | null>(null);
  const [pidSearchQuery, setPidSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files?kind=${section}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: { assets?: WorkspaceAsset[] }; error?: string } | null;
    if (!response.ok || !payload?.success) throw new Error(payload?.error || '资产加载失败');
    setAssets(payload.data?.assets ?? []);
  }, [accountId, section]);

  useEffect(() => {
    setAssets(initialAssets);
  }, [initialAssets]);

  useEffect(() => {
    setVisibleLimit(ASSET_PAGE_SIZE);
    setPublishFilter('unpublished');
    setSelectedAssetIds([]);
    setPidSearchQuery('');
  }, [accountId, section]);

  useEffect(() => {
    setVisibleLimit(ASSET_PAGE_SIZE);
    if (section === 'image' || section === 'inventory-video') setSelectedAssetIds([]);
  }, [pidSearchQuery, publishFilter, section]);

  useEffect(() => {
    if ((section !== 'image' && section !== 'inventory-video') || readOnly) {
      setSelectedAssetIds([]);
      return;
    }
    const existing = new Set(assets.map((asset) => asset.id));
    setSelectedAssetIds((current) => current.filter((id) => existing.has(id)));
  }, [assets, readOnly, section]);

  useEffect(() => {
    if (!viewerAsset) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewerAsset(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewerAsset]);

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length || uploading) return;
    const validFiles = files.filter((file) => isSupportedFile(file, section));
    if (!validFiles.length) {
      setError(section === 'prompt' ? '请拖入 txt、md、json 或 csv 文本文件。' : `请拖入有效的${sectionLabel(section)}文件。`);
      return;
    }
    if (validFiles.length !== files.length) setError(`${files.length - validFiles.length} 个文件格式不支持或超过 100 MB，已跳过。`);
    else setError('');
    setMessage('');
    setUploading(true);
    setUploadState({ total: validFiles.length, completed: 0, succeeded: 0, failed: 0 });
    // Binary assets use one multipart request so a batch only rewrites the
    // account asset index once. Prompt files keep their existing per-file
    // category handling below.
    if (section !== 'prompt') {
      try {
        const form = new FormData();
        form.set('kind', section);
        validFiles.forEach((file) => form.append('files', file));
        const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files`, { method: 'POST', body: form });
        const payload = await response.json().catch(() => null) as { success?: boolean; data?: { assets?: WorkspaceAsset[] }; error?: string } | null;
        if (!response.ok || !payload?.success || !Array.isArray(payload.data?.assets)) throw new Error(payload?.error || '上传失败');
        const uploadedAssets = payload.data.assets;
        setAssets((current) => [...current, ...uploadedAssets]);
        setUploadState((current) => current ? { ...current, completed: validFiles.length, succeeded: uploadedAssets.length } : current);
        setMessage(`已成功上传 ${uploadedAssets.length} 个文件`);
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : '上传失败');
      } finally {
        setUploading(false);
        setUploadState(null);
      }
      return;
    }
    let succeeded = 0;
    let failed = 0;
    for (const file of validFiles) {
      try {
        let response: Response;
        if (section === 'prompt') {
          const content = await file.text();
          response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'prompt', name: file.name.replace(/\.[^.]+$/, ''), content, category: promptTab ?? 'video' }),
          });
        } else {
          const form = new FormData();
          form.set('kind', section);
          form.set('file', file);
          response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files`, { method: 'POST', body: form });
        }
        const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
        if (!response.ok || !payload?.success) throw new Error(payload?.error || '上传失败');
        succeeded += 1;
      } catch {
        failed += 1;
      } finally {
        setUploadState((current) => current ? { ...current, completed: current.completed + 1, succeeded, failed } : current);
      }
    }
    try {
      await refresh();
      setMessage(failed ? `已上传 ${succeeded} 个，${failed} 个失败。` : `已成功上传 ${succeeded} 个文件。`);
    } catch {
      setError('上传完成，但资产列表刷新失败，请稍后重试。');
    } finally {
      setUploading(false);
      setUploadState(null);
    }
  }, [accountId, promptTab, refresh, section, uploading]);

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
  };

  const startRename = (asset: WorkspaceAsset) => {
    setEditingId(asset.id);
    setEditingName(asset.name);
    setMessage('');
    setError('');
  };

  const saveRename = async () => {
    if (!editingId || !editingName.trim()) return;
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(editingId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: editingName.trim() }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: WorkspaceAsset; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '重命名失败');
      setAssets((current) => current.map((asset) => asset.id === editingId ? { ...asset, name: payload.data?.name ?? editingName.trim(), updatedAt: payload.data?.updatedAt ?? new Date().toISOString() } : asset));
      setEditingId(null);
      setEditingName('');
      setMessage('已重命名');
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : '重命名失败');
    }
  };

  const setPublishedState = async (asset: WorkspaceAsset, published: boolean): Promise<WorkspaceAsset> => {
    const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(asset.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ published }),
    });
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: WorkspaceAsset; error?: string } | null;
    if (!response.ok || !payload?.success || !payload.data) throw new Error(payload?.error || '标记失败');
    const saved = payload.data;
    setAssets((current) => current.map((item) => item.id === saved.id ? saved : item));
    return saved;
  };

  const restoreUnpublished = async (asset: WorkspaceAsset) => {
    if (!asset.publishedAt || !window.confirm(`确定把“${asset.name}”恢复为未发布吗？`)) return;
    setMessage('');
    setError('');
    try {
      await setPublishedState(asset, false);
      setMessage('已恢复为未发布');
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : '标记失败');
    }
  };

  const removeAsset = async (asset: WorkspaceAsset) => {
    const isInventoryVideo = asset.kind === 'inventory-video';
    const warning = isInventoryVideo
      ? `确定永久删除“${asset.name}”吗？库存记录、本地视频文件和任务保存的源文件都会一并删除，且不会被系统自动恢复。`
      : `确定删除“${asset.name}”吗？此操作不可撤销。`;
    if (!window.confirm(warning)) return;
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: { sourceFileDeleted?: boolean; deletedGeneratedFiles?: number }; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '删除失败');
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setSelectedAssetIds((current) => current.filter((id) => id !== asset.id));
      setMessage(isInventoryVideo ? '库存视频及本地源文件已永久删除' : '资产已删除');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '删除失败');
    }
  };

  const selectedAssets = useMemo(() => {
    const selected = new Set(selectedAssetIds);
    return assets.filter((asset) => asset.kind === section && selected.has(asset.id));
  }, [assets, section, selectedAssetIds]);

  const toggleSelectedAsset = (assetId: string) => {
    setSelectedAssetIds((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]);
    setMessage('');
    setError('');
  };

  const removeSelectedAssets = async () => {
    if (section !== 'image' || readOnly || bulkDeleting || selectedAssets.length === 0) return;
    const count = selectedAssets.length;
    if (!window.confirm(`确定删除已选择的 ${count} 张素材图吗？此操作不可撤销。`)) return;
    setBulkDeleting(true);
    setMessage('');
    setError('');
    let succeeded = 0;
    let failed = 0;
    const deletedIds: string[] = [];
    for (const asset of selectedAssets) {
      try {
        const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
        const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
        if (!response.ok || !payload?.success) throw new Error(payload?.error || 'delete_failed');
        succeeded += 1;
        deletedIds.push(asset.id);
      } catch {
        failed += 1;
      }
    }
    if (deletedIds.length) {
      const deleted = new Set(deletedIds);
      setAssets((current) => current.filter((asset) => !deleted.has(asset.id)));
      setSelectedAssetIds((current) => current.filter((id) => !deleted.has(id)));
    }
    setBulkDeleting(false);
    if (failed) setError(`已删除 ${succeeded} 张，${failed} 张删除失败，请刷新后重试。`);
    else setMessage(`已删除 ${succeeded} 张素材图`);
  };

  const triggerDirectDownload = (asset: WorkspaceAsset) => {
    const anchor = document.createElement('a');
    anchor.href = assetUrl(accountId, asset.id, true);
    anchor.download = downloadName(asset);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const downloadAsset = async (asset: WorkspaceAsset, quiet = false): Promise<boolean> => {
    try {
      if (!quiet) {
        setMessage('');
        setError('');
      }
      if (asset.kind === 'prompt') {
        const blob = new Blob([asset.content ?? ''], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        const name = downloadName(asset);
        anchor.download = name.includes('.') ? name : `${name}.txt`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        return true;
      }
      if (asset.kind === 'inventory-video') {
        if (!readOnly && !asset.publishedAt) await setPublishedState(asset, true);
        triggerDirectDownload(asset);
        if (!quiet) setMessage(readOnly ? '已开始下载视频' : '已开始下载，视频已自动进入已发布');
        return true;
      }
      const response = await fetch(assetUrl(accountId, asset.id, true));
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadName(asset);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      return true;
    } catch (downloadError) {
      if (!quiet) setError(downloadError instanceof Error ? downloadError.message : '下载失败');
      return false;
    }
  };

  const downloadSelectedVideos = async () => {
    if (section !== 'inventory-video' || readOnly || bulkDownloading || selectedAssets.length === 0) return;
    setBulkDownloading(true);
    setMessage('');
    setError('');
    let succeeded = 0;
    const downloadedIds: string[] = [];
    for (const asset of selectedAssets) {
      if (await downloadAsset(asset, true)) {
        succeeded += 1;
        downloadedIds.push(asset.id);
      }
    }
    if (downloadedIds.length) {
      const downloaded = new Set(downloadedIds);
      setSelectedAssetIds((current) => current.filter((id) => !downloaded.has(id)));
    }
    const failed = selectedAssets.length - succeeded;
    setBulkDownloading(false);
    if (failed) setError(`已开始下载 ${succeeded} 个视频，${failed} 个下载或发布标记失败，请重试。`);
    else setMessage(`已开始下载 ${succeeded} 个视频，并自动进入已发布`);
  };

  const helperText = useMemo(() => {
    if (section === 'prompt') return '支持批量拖入 txt、md、json、csv，文件内容会自动保存为提示词模板。';
    if (section === 'image') return '支持 PNG、JPG、WEBP、GIF、AVIF、BMP、TIFF 等常见图片格式，可一次拖入多个文件。';
    if (section === 'inventory-video') return '支持 MP4、WEBM、MOV 等视频格式，可一次拖入多个文件。';
    return '支持 MP3、WAV、OGG、M4A、AAC、FLAC 等音频格式，可一次拖入多个文件。';
  }, [section]);

  const publishedCount = section === 'inventory-video' ? assets.filter((item) => item.publishedAt).length : 0;
  const unpublishedCount = section === 'inventory-video' ? assets.length - publishedCount : 0;
  const pidSearchEnabled = section === 'image' || section === 'inventory-video';
  const pidFilteredAssets = pidSearchEnabled
    ? assets.filter((asset) => matchesAssetPidPrefix(asset.name, pidSearchQuery))
    : assets;
  const filteredAssets = section === 'inventory-video'
    ? pidFilteredAssets.filter((item) => (publishFilter === 'published' ? Boolean(item.publishedAt) : !item.publishedAt))
    : pidFilteredAssets;
  const visibleAssets = filteredAssets.slice(0, visibleLimit);
  const materialBulkSelectionEnabled = section === 'image' && !readOnly;
  const videoBulkSelectionEnabled = section === 'inventory-video' && !readOnly;
  const selectedCount = selectedAssets.length;
  const filteredSelectableIds = section === 'image' || section === 'inventory-video' ? filteredAssets.map((asset) => asset.id) : [];
  const selectedIdSet = new Set(selectedAssetIds);
  const allFilteredAssetsSelected = filteredSelectableIds.length > 0 && filteredSelectableIds.every((id) => selectedIdSet.has(id));

  const toggleSelectAllAssets = () => {
    if (!filteredSelectableIds.length || bulkDeleting || bulkDownloading) return;
    const filteredIds = new Set(filteredSelectableIds);
    setSelectedAssetIds((current) => allFilteredAssetsSelected
      ? current.filter((id) => !filteredIds.has(id))
      : [...new Set([...current, ...filteredSelectableIds])]);
    setMessage('');
    setError('');
  };

  return <div className={`account-asset-library ${section}`}>
    {(materialBulkSelectionEnabled || videoBulkSelectionEnabled) && <div className="asset-bulk-toolbar" aria-label={section === 'image' ? '素材图批量操作' : '库存视频批量操作'}>
      <button type="button" className="asset-select-all-button" disabled={bulkDeleting || bulkDownloading || filteredSelectableIds.length === 0} onClick={toggleSelectAllAssets} aria-pressed={allFilteredAssetsSelected}><Check size={14} /> {allFilteredAssetsSelected ? (pidSearchQuery.trim() ? '取消全选结果' : '取消全选') : (pidSearchQuery.trim() ? `全选结果 (${filteredSelectableIds.length})` : `全选 (${filteredSelectableIds.length})`)}</button>
      {materialBulkSelectionEnabled && <button type="button" className="asset-bulk-delete-button" disabled={bulkDeleting || selectedCount === 0} onClick={() => void removeSelectedAssets()}><Trash2 size={14} /> {bulkDeleting ? '删除中…' : `批量删除已选 (${selectedCount})`}</button>}
      {videoBulkSelectionEnabled && <button type="button" className="asset-bulk-download-button" disabled={bulkDownloading || selectedCount === 0} onClick={() => void downloadSelectedVideos()}><Download size={14} /> {bulkDownloading ? '下载中…' : `批量下载已选 (${selectedCount})`}</button>}
    </div>}
    {!readOnly && <div
      className={`asset-dropzone ${dragging ? 'dragging' : ''} ${uploading ? 'uploading' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inputRef.current?.click(); } }}
      onClick={() => inputRef.current?.click()}
      aria-label={`拖入或选择${sectionLabel(section)}文件`}
    >
      <input ref={inputRef} type="file" multiple accept={acceptFor(section)} hidden onChange={(event) => { if (event.target.files) void handleFiles(event.target.files); event.currentTarget.value = ''; }} />
      <span className="asset-dropzone-icon"><UploadCloud size={22} /></span>
      <strong>{uploading ? '正在上传…' : `拖入${sectionLabel(section)}文件到这里`}</strong>
      <span>{helperText}</span>
      <span className="ghost-button" aria-hidden="true"><UploadCloud size={14} /> 选择文件</span>
    </div>}
    {uploadState && <div className="asset-upload-status" role="status"><Loader2 size={14} className="spin" /> 上传进度 {uploadState.completed}/{uploadState.total}{uploadState.failed ? ` · 失败 ${uploadState.failed}` : ''}</div>}
    {message && <div className="asset-feedback success" role="status"><Check size={14} />{message}</div>}
    {error && <div className="asset-feedback error" role="alert"><X size={14} />{error}</div>}
    {section === 'prompt' && !readOnly && <PromptTemplateEditor accountId={accountId} initialAssets={assets} initialCategory={promptTab} onSaved={refresh} />}
    {pidSearchEnabled && <div className="asset-pid-searchbar" role="search">
      <Search size={16} aria-hidden="true" />
      <input value={pidSearchQuery} onChange={(event) => setPidSearchQuery(event.target.value)} placeholder="搜索 PID 前缀" aria-label="按 PID 前缀搜索库存" autoComplete="off" spellCheck={false} />
      {pidSearchQuery && <button type="button" onClick={() => setPidSearchQuery('')} title="清空搜索" aria-label="清空 PID 搜索"><X size={15} /></button>}
      <span aria-live="polite">{pidSearchQuery.trim() ? `${filteredAssets.length} 项` : `${assets.length} 项`}</span>
    </div>}
    {section === 'inventory-video' && assets.length > 0 && <div className="publish-filter-tabs" role="tablist" aria-label="库存视频发布状态">
      <button type="button" role="tab" aria-selected={publishFilter === 'unpublished'} className={publishFilter === 'unpublished' ? 'active' : ''} onClick={() => setPublishFilter('unpublished')}>未发布 <span>{unpublishedCount}</span></button>
      <button type="button" role="tab" aria-selected={publishFilter === 'published'} className={publishFilter === 'published' ? 'active' : ''} onClick={() => setPublishFilter('published')}>已发布 <span>{publishedCount}</span></button>
    </div>}
    {section !== 'prompt' && !assets.length && <div className="asset-empty"><FolderOpen size={18} />还没有{sectionLabel(section)}资产，拖入文件即可开始。</div>}
    {section !== 'prompt' && assets.length > 0 && !visibleAssets.length && <div className="asset-empty"><FolderOpen size={18} />{pidSearchQuery.trim() ? `未找到以“${pidSearchQuery.trim()}”开头的 PID 资产` : section === 'inventory-video' && publishFilter === 'published' ? '还没有已发布的视频。' : section === 'inventory-video' ? '没有待发布的视频，全部已发布。' : '暂无资产'}</div>}
    {section !== 'prompt' && visibleAssets.length > 0 && <div className={`asset-card-grid ${section === 'image' ? 'image-grid' : 'media-grid'}`}>
      {visibleAssets.map((asset) => {
        const isEditing = editingId === asset.id;
        const isSelected = selectedAssetIds.includes(asset.id);
        return <article className={`asset-card ${section === 'image' ? 'asset-image-card' : 'asset-media-card'} ${isSelected ? 'is-selected' : ''}`} key={asset.id}>
          {section === 'image' && <div className="asset-image-preview"><button type="button" className="asset-image-open" onClick={() => setViewerAsset(asset)} aria-label={`放大查看 ${asset.name}`} title="点击放大查看">{asset.relativePath ? <img src={assetUrl(accountId, asset.id)} alt={asset.name} loading="lazy" /> : <FileImage size={28} />}</button>{materialBulkSelectionEnabled && <button type="button" className={`asset-card-select ${isSelected ? 'is-selected' : ''}`} onClick={() => toggleSelectedAsset(asset.id)} title={isSelected ? '取消选择' : '选择素材图'} aria-pressed={isSelected} aria-label={`${isSelected ? '取消选择' : '选择'} ${asset.name}`}>{isSelected ? <Check size={14} /> : null}</button>}</div>}
          {section === 'inventory-video' && <div className="asset-media-preview"><video src={assetUrl(accountId, asset.id)} controls preload="metadata" />{videoBulkSelectionEnabled && <button type="button" className={`asset-card-select video-select ${isSelected ? 'is-selected' : ''}`} onClick={() => toggleSelectedAsset(asset.id)} title={isSelected ? '取消选择' : '选择库存视频'} aria-pressed={isSelected} aria-label={`${isSelected ? '取消选择' : '选择'} ${asset.name}`}>{isSelected ? <Check size={14} /> : null}</button>}</div>}
          {section === 'audio' && <div className="asset-media-preview audio"><AudioLines size={28} /><audio src={assetUrl(accountId, asset.id)} controls preload="metadata" /></div>}
          <div className="asset-card-body">
            {isEditing ? <div className="asset-rename-row"><input value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setEditingId(null); }} autoFocus aria-label="资产名称" /><button type="button" className="asset-card-action" onClick={() => void saveRename()} title="保存命名"><Check size={15} /></button><button type="button" className="asset-card-action" onClick={() => setEditingId(null)} title="取消"><X size={15} /></button></div> : <strong title={asset.name}>{asset.name}</strong>}
            <span>{asset.mimeType ?? sectionLabel(section)} · {formatBytes(asset.size)}</span>
            <small>{new Date(asset.updatedAt || asset.createdAt).toLocaleDateString('zh-CN')}</small>
            {section === 'inventory-video' && asset.publishedAt && <small className="asset-published-badge"><Check size={12} /> 已发布 · {new Date(asset.publishedAt).toLocaleDateString('zh-CN')}</small>}
          </div>
          <div className="asset-card-actions" aria-label={`${asset.name} 操作`}>
            <button type="button" className="asset-card-action" onClick={() => void downloadAsset(asset)} title="下载" aria-label={`下载 ${asset.name}`}><Download size={15} /></button>
            {!readOnly && section === 'inventory-video' && asset.publishedAt && <button type="button" className="asset-card-action asset-publish-action is-published" onClick={() => void restoreUnpublished(asset)} title="恢复为未发布" aria-label={`恢复为未发布 ${asset.name}`}><X size={15} /> 恢复未发布</button>}
            {!readOnly && <><button type="button" className="asset-card-action" onClick={() => startRename(asset)} title="重命名" aria-label={`重命名 ${asset.name}`}><Pencil size={15} /></button>
            <button type="button" className="asset-card-action danger" onClick={() => void removeAsset(asset)} title="删除" aria-label={`删除 ${asset.name}`}><Trash2 size={15} /></button></>}
          </div>
        </article>;
      })}
    </div>}
    {section !== 'prompt' && filteredAssets.length > visibleLimit && <button type="button" className="ghost-button asset-load-more" onClick={() => setVisibleLimit((current) => current + ASSET_PAGE_SIZE)}>加载更多（剩余 {filteredAssets.length - visibleLimit} 个）</button>}
    {viewerAsset && <div className="modal-backdrop asset-image-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewerAsset(null); }}>
      <section className="modal-card asset-image-viewer-modal" role="dialog" aria-modal="true" aria-labelledby="asset-image-viewer-title">
        <div className="panel-header"><div><h2 id="asset-image-viewer-title" className="panel-title" title={viewerAsset.name}>{viewerAsset.name}</h2></div><button type="button" className="icon-button" onClick={() => setViewerAsset(null)} aria-label="关闭图片预览" title="关闭"><X size={17} /></button></div>
        <div className="asset-image-viewer-stage"><ReviewZoomableMedia src={assetUrl(accountId, viewerAsset.id)} alt={viewerAsset.name} /></div>
      </section>
    </div>}
  </div>;
}
