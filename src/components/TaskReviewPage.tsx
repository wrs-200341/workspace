'use client';

import Link from 'next/link';
import { ArrowLeft, CircleAlert, Download, Film, LoaderCircle, PackageCheck, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type ReviewTask = {
  id: string;
  accountId: string;
  mode: 'video' | 'image' | 'prompt';
  provider?: string;
  providerTaskId?: string;
  model?: string;
  prompt?: string;
  status: string;
  progress: number;
  createdAt: string;
  updatedAt?: string;
  inventorySavedAt?: string;
  outputUrls?: string[];
  outputBase64?: string[];
  outputCount?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  providerResponse?: unknown;
};

export function TaskReviewPage({ accountId, taskId, mode }: { accountId: string; taskId: string; mode: 'video' | 'image' }) {
  const router = useRouter();
  const [task, setTask] = useState<ReviewTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloadingIndex, setDownloadingIndex] = useState<number | null>(null);
  const [selectedReferenceIndex, setSelectedReferenceIndex] = useState(0);
  const endpoint = `/api/workspace/accounts/${accountId}/${mode === 'video' ? 'video-tasks' : 'image-tasks'}/${encodeURIComponent(taskId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: ReviewTask; error?: string } | null;
      if (!response.ok || !payload?.success || !payload.data) throw new Error(payload?.error || '任务加载失败');
      setTask(payload.data);
      setMessage('');
    } catch (error) {
      setTask(null);
      setMessage(error instanceof Error ? error.message : '任务加载失败');
    } finally { setLoading(false); }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!task || !['queued', 'prompting', 'submitting', 'submitted', 'processing', 'running'].includes(task.status)) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [load, task]);

  async function action(actionName: 'save-inventory' | 'pause' | 'resume' | 'cancel') {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }) });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: ReviewTask; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '任务操作失败');
      if (payload.data) setTask(payload.data);
      if (actionName === 'save-inventory') {
        const savedTask = payload.data ?? task;
        const queueDate = savedTask ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(savedTask.createdAt)) : '';
        const query = new URLSearchParams({ mode, focusTaskId: savedTask?.id ?? taskId });
        if (queueDate) query.set('queueDate', queueDate);
        router.push(`/workspace/accounts/${encodeURIComponent(accountId)}/production?${query.toString()}`);
        return;
      }
      setMessage('任务状态已更新');
    } catch (error) { setMessage(error instanceof Error ? error.message : '任务操作失败'); }
    finally { setBusy(false); }
  }

  async function downloadOutput(url: string, index: number) {
    if (downloadingIndex !== null) return;
    setDownloadingIndex(index);
    if (mode === 'image' && /^\//.test(url)) {
      const directUrl = `${url}${url.includes('?') ? '&' : '?'}download=1`;
      const directAnchor = document.createElement('a');
      directAnchor.href = directUrl;
      directAnchor.download = `workspace-${taskId}-${index + 1}.png`;
      document.body.appendChild(directAnchor);
      directAnchor.click();
      directAnchor.remove();
      setDownloadingIndex(null);
      return;
    }
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `workspace-${taskId}-${index + 1}.${mode === 'video' ? 'mp4' : 'png'}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      if (error instanceof TypeError && /^\//.test(url)) {
        const directUrl = `${url}${url.includes('?') ? '&' : '?'}download=1`;
        const directAnchor = document.createElement('a');
        directAnchor.href = directUrl;
        directAnchor.download = `workspace-${taskId}-${index + 1}.${mode === 'video' ? 'mp4' : 'png'}`;
        document.body.appendChild(directAnchor);
        directAnchor.click();
        directAnchor.remove();
        setMessage('');
        return;
      }
      setMessage(error instanceof Error ? error.message : '下载失败');
    } finally {
      setDownloadingIndex(null);
    }
  }

  const metadata = task?.metadata ?? {};
  const references = useMemo(() => {
    const referenceAssetIds = stringArray(metadata.referenceAssetIds);
    const productImageAssetIds = stringArray(metadata.productImageAssetIds);
    const genericAssetIds = stringArray(metadata.assetIds);
    const referenceAssetOrder = assetSelectionArray(metadata.referenceAssetOrder).filter((item) => item.kind === 'image' || item.kind === 'product-image');
    const referenceTokens = stringArray(metadata.referenceTokens);
    const persistedIds = referenceAssetOrder.length
      ? referenceAssetOrder.map((item) => item.id)
      : [
        ...referenceAssetIds,
        ...productImageAssetIds,
        ...(referenceAssetIds.length || productImageAssetIds.length ? [] : genericAssetIds),
      ];
    const persistedKinds = referenceAssetOrder.length
      ? referenceAssetOrder.map((item) => item.kind)
      : persistedIds.map((assetId) => productImageAssetIds.includes(assetId) ? 'product-image' as const : 'image' as const);
    // Prefer the durable account/product asset URLs for review. Public bridge
    // tokens are short-lived and are only used when a task has no persisted
    // local asset id (for example an externally supplied reference URL).
    const durableIds = persistedIds.map((assetId, index) => persistedKinds[index] === 'product-image' ? `product-image:${assetId}` : assetId);
    const values = [
      ...stringArray(metadata.referenceImages),
      ...durableIds,
      ...stringArray(metadata.externalReferenceImages),
      ...(persistedIds.length ? [] : referenceTokens.map((token) => `reference-token:${token}`)),
    ];
    return [...new Set(values)];
  }, [metadata]);
  const referenceUrls = useMemo(() => references.map((reference) => {
    if (/^https?:\/\//i.test(reference)) return reference;
    if (reference.startsWith('reference-token:')) return `/api/workspace/references/${encodeURIComponent(reference.slice('reference-token:'.length))}`;
    if (reference.startsWith('product-image:')) return `/api/workspace/product-images/preview?assetId=${encodeURIComponent(reference)}`;
    return `/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(reference)}`;
  }), [accountId, references]);
  useEffect(() => {
    setSelectedReferenceIndex((current) => referenceUrls.length ? Math.min(current, referenceUrls.length - 1) : 0);
  }, [referenceUrls.length]);
  // Display only outputs that can actually be previewed/downloaded. Legacy
  // outputCount metadata without a URL or stored Base64 payload is not a
  // production result and must not appear as a real count.
  const outputCount = (task?.outputUrls?.filter((value) => value.trim()).length ?? 0) + (task?.outputBase64?.filter((value) => value.trim()).length ?? 0);
  const outputUrls = useMemo(() => {
    const urls = task?.outputUrls ?? [];
    if (mode === 'image') {
      // Image providers may return cross-origin CDN URLs. Route previews and
      // downloads through the authenticated same-origin proxy so the browser
      // is not blocked by CORS when the operator clicks 下载.
      return urls.map((_url, index) => `${endpoint}/outputs/${index}`);
    }
    if (!task?.providerTaskId || !task.provider || !['grok-video', 'mgrouter-grok-video', 'oairegbox-omni'].includes(task.provider)) return urls;
    // These providers require bearer auth for /videos/{id}/content. Route
    // previews/downloads through the workspace proxy instead of exposing a
    // direct unauthenticated upstream URL that would return HTTP 401.
    return urls.map((_url, index) => `${endpoint}/outputs/${index}`);
  }, [endpoint, mode, task]);
  const outputSources = useMemo(() => [
    ...outputUrls,
    ...(task?.outputBase64 ?? []).map((value) => value.startsWith('data:') ? value : `data:${mode === 'video' ? 'video/mp4' : 'image/png'};base64,${value}`),
  ], [mode, outputUrls, task?.outputBase64]);
  const restoreHref = task
    ? `/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${encodeURIComponent(mode)}&restoreTaskId=${encodeURIComponent(task.id)}`
    : `/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${encodeURIComponent(mode)}`;
  return <div className={`task-review-page ${mode === 'video' ? 'video-task-review' : 'image-task-review'}`}>
    <div className="task-review-topbar">
      <Link href={`/workspace/accounts/${accountId}/production?mode=${mode}`} className="panel-meta task-review-back"><ArrowLeft size={13} /> 返回生产工作区</Link>
      <span className={`status ${task?.status === 'failed' ? 'attention' : ''}`}><span className="dot" />{loading ? '加载中' : task?.status ?? 'unknown'}</span>
    </div>
    {message && <div className="workspace-alert task-review-alert" role="status"><CircleAlert size={16} /><div><strong>{message}</strong></div></div>}
    {task?.error && <div className="workspace-alert task-review-alert" role="alert"><CircleAlert size={16} /><div><strong>供应商返回错误</strong><span>{task.error}</span></div></div>}
    {Boolean(task?.providerResponse) && <details className="task-provider-response"><summary>查看完整供应商响应</summary><pre>{JSON.stringify(task?.providerResponse, null, 2) ?? ''}</pre></details>}
    <div className="task-review-stage">
      <section className="panel task-review-pane task-output-pane">
        <div className="panel-header task-review-pane-header"><div><h2 className="panel-title">输出预览</h2><div className="panel-meta">任务成品</div></div><Film size={16} color="#1e40af" /></div>
        <div className="task-output-list">{outputSources.length > 0 ? outputSources.map((url, index) => <ZoomableMedia key={`${url}-${index}`} src={url} alt={`任务输出 ${index + 1}`} video={mode === 'video'} />) : <div className="task-review-empty">任务尚未生成输出</div>}</div>
        <div className="task-review-actions"><span className="task-review-count">输出 {outputCount}</span><span className="task-review-inventory">{task?.inventorySavedAt ? '已入库' : '待入库'}</span><div className="review-buttons"><Link className="ghost-button" href={restoreHref}><RotateCcw size={14} /> 恢复配置</Link><button className="ghost-button" type="button" onClick={() => void action('save-inventory')} disabled={busy || !task || task.status !== 'completed' || Boolean(task.inventorySavedAt)}><PackageCheck size={14} /> 写入库存</button>{outputSources.map((url, index) => <button className="primary-button" key={`${url}-${index}`} type="button" onClick={() => void downloadOutput(url, index)} disabled={downloadingIndex !== null}><Download size={14} /> 下载</button>)}</div></div>
      </section>
      <aside className="panel task-review-pane task-reference-pane">
        <div className="panel-header task-review-pane-header"><div><h2 className="panel-title">参考图</h2><div className="panel-meta">{referenceUrls.length} 张 · 点击缩略图预览</div></div></div>
        {referenceUrls.length > 0 ? <>
          <div className="task-reference-selected"><ZoomableMedia src={referenceUrls[selectedReferenceIndex]} alt={`参考图 ${selectedReferenceIndex + 1}`} /></div>
          <div className="task-reference-thumbnails" role="listbox" aria-label="选择参考图">
            {referenceUrls.map((url, index) => <ReferenceThumbnail key={`${url}-${index}`} src={url} index={index} active={selectedReferenceIndex === index} onSelect={() => setSelectedReferenceIndex(index)} />)}
          </div>
        </> : <div className="task-review-empty">未使用参考图</div>}
      </aside>
    </div>
  </div>;
}

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function assetSelectionArray(value: unknown): Array<{ id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' } => Boolean(item && typeof item === 'object') && typeof (item as { id?: unknown }).id === 'string' && ['image', 'product-image', 'inventory-video', 'audio'].includes(String((item as { kind?: unknown }).kind))).map((item) => ({ id: item.id.trim(), kind: item.kind }));
}
function ReferenceThumbnail({ src, index, active, onSelect }: { src: string; index: number; active: boolean; onSelect: () => void }) {
  const [failed, setFailed] = useState(false);
  return <button type="button" className={`task-reference-thumbnail ${active ? 'active' : ''}`} onClick={onSelect} aria-label={`查看参考图 ${index + 1}`} aria-selected={active}>
    {failed ? <span className="task-thumbnail-fallback">不可用</span> : <img src={src} alt={`参考图 ${index + 1} 缩略图`} onError={() => setFailed(true)} />}
  </button>;
}
function ZoomableMedia({ src, alt, video = false }: { src: string; alt: string; video?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  return <div className={`task-media-zoom ${video ? 'task-video-media' : ''}`}>
    {video ? <video src={src} controls preload="metadata" playsInline aria-label={alt} /> : imageFailed ? <div className="task-media-fallback" role="img" aria-label={`${alt}不可用`}>图片不可用</div> : <img src={src} alt={alt} draggable={false} onError={() => setImageFailed(true)} />}
  </div>;
}
