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
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { AssetKind, PromptAssetCategory, WorkspaceAsset } from '@/lib/workspace/assetStore';
import { PromptTemplateEditor } from './PromptTemplateEditor';

type Props = {
  accountId: string;
  section: AssetKind;
  initialAssets: WorkspaceAsset[];
  promptTab?: PromptAssetCategory;
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

export function AccountAssetLibrary({ accountId, section, initialAssets, promptTab }: Props) {
  const [assets, setAssets] = useState<WorkspaceAsset[]>(initialAssets);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
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
  }, [accountId, refresh, section, uploading]);

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

  const removeAsset = async (asset: WorkspaceAsset) => {
    if (!window.confirm(`确定删除“${asset.name}”吗？此操作不可撤销。`)) return;
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '删除失败');
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setMessage('资产已删除');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '删除失败');
    }
  };

  const downloadAsset = async (asset: WorkspaceAsset) => {
    try {
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
        return;
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
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : '下载失败');
    }
  };

  const helperText = useMemo(() => {
    if (section === 'prompt') return '支持批量拖入 txt、md、json、csv，文件内容会自动保存为提示词模板。';
    if (section === 'image') return '支持 PNG、JPG、WEBP、GIF、AVIF、BMP、TIFF 等常见图片格式，可一次拖入多个文件。';
    if (section === 'inventory-video') return '支持 MP4、WEBM、MOV 等视频格式，可一次拖入多个文件。';
    return '支持 MP3、WAV、OGG、M4A、AAC、FLAC 等音频格式，可一次拖入多个文件。';
  }, [section]);

  return <div className={`account-asset-library ${section}`}>
    <div
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
    </div>
    {uploadState && <div className="asset-upload-status" role="status"><Loader2 size={14} className="spin" /> 上传进度 {uploadState.completed}/{uploadState.total}{uploadState.failed ? ` · 失败 ${uploadState.failed}` : ''}</div>}
    {message && <div className="asset-feedback success" role="status"><Check size={14} />{message}</div>}
    {error && <div className="asset-feedback error" role="alert"><X size={14} />{error}</div>}
    {section === 'prompt' && <PromptTemplateEditor accountId={accountId} initialAssets={assets} initialCategory={promptTab} onSaved={refresh} />}
    {section !== 'prompt' && !assets.length && <div className="asset-empty"><FolderOpen size={18} />还没有{sectionLabel(section)}资产，拖入文件即可开始。</div>}
    {section !== 'prompt' && assets.length > 0 && <div className={`asset-card-grid ${section === 'image' ? 'image-grid' : 'media-grid'}`}>
      {assets.map((asset) => {
        const isEditing = editingId === asset.id;
        return <article className={`asset-card ${section === 'image' ? 'asset-image-card' : 'asset-media-card'}`} key={asset.id}>
          {section === 'image' && <div className="asset-image-preview">{asset.relativePath ? <img src={assetUrl(accountId, asset.id)} alt={asset.name} loading="lazy" /> : <FileImage size={28} />}</div>}
          {section === 'inventory-video' && <div className="asset-media-preview"><video src={assetUrl(accountId, asset.id)} controls preload="metadata" /></div>}
          {section === 'audio' && <div className="asset-media-preview audio"><AudioLines size={28} /><audio src={assetUrl(accountId, asset.id)} controls preload="metadata" /></div>}
          <div className="asset-card-body">
            {isEditing ? <div className="asset-rename-row"><input value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setEditingId(null); }} autoFocus aria-label="资产名称" /><button type="button" className="asset-card-action" onClick={() => void saveRename()} title="保存命名"><Check size={15} /></button><button type="button" className="asset-card-action" onClick={() => setEditingId(null)} title="取消"><X size={15} /></button></div> : <strong title={asset.name}>{asset.name}</strong>}
            <span>{asset.mimeType ?? sectionLabel(section)} · {formatBytes(asset.size)}</span>
            <small>{new Date(asset.updatedAt || asset.createdAt).toLocaleDateString('zh-CN')}</small>
          </div>
          <div className="asset-card-actions" aria-label={`${asset.name} 操作`}>
            <button type="button" className="asset-card-action" onClick={() => void downloadAsset(asset)} title="下载" aria-label={`下载 ${asset.name}`}><Download size={15} /></button>
            <button type="button" className="asset-card-action" onClick={() => startRename(asset)} title="重命名" aria-label={`重命名 ${asset.name}`}><Pencil size={15} /></button>
            <button type="button" className="asset-card-action danger" onClick={() => void removeAsset(asset)} title="删除" aria-label={`删除 ${asset.name}`}><Trash2 size={15} /></button>
          </div>
        </article>;
      })}
    </div>}
  </div>;
}
