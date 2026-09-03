'use client';

import Link from 'next/link';
import { ArrowLeft, CircleAlert, Download, Film, LoaderCircle, PackageCheck, RotateCcw, ZoomIn, ZoomOut, RotateCcw as ResetZoom } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type WheelEvent } from 'react';

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
};

export function TaskReviewPage({ accountId, taskId, mode }: { accountId: string; taskId: string; mode: 'video' | 'image' }) {
  const [task, setTask] = useState<ReviewTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloadingIndex, setDownloadingIndex] = useState<number | null>(null);
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
      setMessage(actionName === 'save-inventory' ? '成品已写入库存' : '任务状态已更新');
    } catch (error) { setMessage(error instanceof Error ? error.message : '任务操作失败'); }
    finally { setBusy(false); }
  }

  async function downloadOutput(url: string, index: number) {
    if (downloadingIndex !== null) return;
    setDownloadingIndex(index);
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
    const values = [
      ...stringArray(metadata.referenceImages),
      ...referenceAssetIds,
      ...productImageAssetIds,
      // Older image tasks only persisted assetIds. Video tasks now persist
      // kind-specific ids, so never render their video/audio ids as images.
      ...(referenceAssetIds.length || productImageAssetIds.length ? [] : genericAssetIds),
      ...stringArray(metadata.externalReferenceImages),
    ];
    return [...new Set(values)];
  }, [metadata]);
  const referenceUrls = useMemo(() => references.map((reference) => {
    if (/^https?:\/\//i.test(reference)) return reference;
    if (reference.startsWith('product-image:')) return `/api/workspace/product-images/preview?assetId=${encodeURIComponent(reference)}`;
    return `/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(reference)}`;
  }), [accountId, references]);
  // Display only outputs that can actually be previewed/downloaded. Legacy
  // outputCount metadata without a URL or stored Base64 payload is not a
  // production result and must not appear as a real count.
  const outputCount = (task?.outputUrls?.filter((value) => value.trim()).length ?? 0) + (task?.outputBase64?.filter((value) => value.trim()).length ?? 0);
  const outputUrls = useMemo(() => {
    const urls = task?.outputUrls ?? [];
    if (!task?.providerTaskId || !task.provider || !['grok-video', 'mgrouter-grok-video', 'oairegbox-omni'].includes(task.provider)) return urls;
    // These providers require bearer auth for /videos/{id}/content. Route
    // previews/downloads through the workspace proxy instead of exposing a
    // direct unauthenticated upstream URL that would return HTTP 401.
    return urls.map((_url, index) => `${endpoint}/outputs/${index}`);
  }, [endpoint, task]);
  const outputSources = useMemo(() => [
    ...outputUrls,
    ...(task?.outputBase64 ?? []).map((value) => value.startsWith('data:') ? value : `data:${mode === 'video' ? 'video/mp4' : 'image/png'};base64,${value}`),
  ], [mode, outputUrls, task?.outputBase64]);
  const restoreHref = task
    ? `/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${encodeURIComponent(mode)}&restoreTaskId=${encodeURIComponent(task.id)}`
    : `/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${encodeURIComponent(mode)}`;
  const metadataPrompt = typeof metadata.originalPrompt === 'string' ? metadata.originalPrompt : '';
  const metadataChildPrompt = typeof metadata.childPrompt === 'string' ? metadata.childPrompt : '';
  const metadataFinalPrompt = typeof metadata.finalPrompt === 'string' ? metadata.finalPrompt : '';

  return <div className="task-review-page">
    <div className="page-heading task-review-heading"><div><Link href={`/workspace/accounts/${accountId}/production?mode=${mode}`} className="panel-meta task-review-back"><ArrowLeft size={13} /> 返回生产工作区</Link><div className="eyebrow task-review-eyebrow">Production / task review</div><h1>{task?.prompt?.slice(0, 80) || '任务详情'}</h1><p className="subtitle">{task ? `${task.model ?? task.provider ?? 'provider'} · ${task.providerTaskId ?? task.id}` : `任务 ${taskId} 不在当前队列中`}</p></div><div className="toolbar"><span className={`status ${task?.status === 'failed' ? 'attention' : ''}`}><span className="dot" />{loading ? '加载中' : task?.status ?? 'unknown'}</span></div></div>
    {message && <div className="workspace-alert task-review-alert" role="status"><CircleAlert size={16} /><div><strong>{message}</strong></div></div>}
    {task?.error && <div className="workspace-alert task-review-alert" role="alert"><CircleAlert size={16} /><div><strong>供应商返回错误</strong><span>{task.error}</span></div></div>}
    <div className="task-review-stage">
      <section className="panel task-review-pane task-output-pane">
        <div className="panel-header task-review-pane-header"><div><h2 className="panel-title">输出预览</h2><div className="panel-meta">任务成品</div></div><Film size={16} color="#1e40af" /></div>
        <div className="task-output-list">{outputSources.length > 0 ? outputSources.map((url, index) => <ZoomableMedia key={`${url}-${index}`} src={url} alt={`任务输出 ${index + 1}`} video={mode === 'video'} />) : <div className="task-review-empty">任务尚未生成输出</div>}</div>
        <div className="task-review-actions"><span className="task-review-count">输出 {outputCount}</span><span className="task-review-inventory">{task?.inventorySavedAt ? '已入库' : '待入库'}</span><div className="review-buttons"><Link className="ghost-button" href={restoreHref}><RotateCcw size={14} /> 恢复配置</Link><button className="ghost-button" type="button" onClick={() => void action('save-inventory')} disabled={busy || !task || task.status !== 'completed' || Boolean(task.inventorySavedAt)}><PackageCheck size={14} /> 写入库存</button>{outputSources.map((url, index) => <button className="primary-button" key={`${url}-${index}`} type="button" onClick={() => void downloadOutput(url, index)} disabled={downloadingIndex !== null}><Download size={14} /> 下载</button>)}</div></div>
      </section>
      <aside className="panel task-review-pane task-reference-pane">
        <section className="task-prompt-pane" id="prompt">
          <div className="panel-header task-review-pane-header"><div><h2 className="panel-title">提示词</h2><div className="panel-meta">任务提交时保存的提示词配置</div></div></div>
          <div className="task-prompt-details">
            <label>原始提示词<textarea readOnly value={metadataPrompt || task?.prompt || ''} /></label>
            {metadataChildPrompt && <label>自动生成子提示词<textarea readOnly value={metadataChildPrompt} /></label>}
            {metadataFinalPrompt && metadataFinalPrompt !== metadataPrompt && <label>最终提交提示词<textarea readOnly value={metadataFinalPrompt} /></label>}
          </div>
        </section>
        <div className="panel-header task-review-pane-header"><div><h2 className="panel-title">参考图</h2><div className="panel-meta">{referenceUrls.length} 张</div></div></div>
        <div className="task-reference-list">{referenceUrls.length > 0 ? referenceUrls.map((url, index) => <ZoomableMedia key={`${url}-${index}`} src={url} alt={`参考图 ${index + 1}`} />) : <div className="task-review-empty">未使用参考图</div>}</div>
      </aside>
    </div>
  </div>;
}

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function ZoomableMedia({ src, alt, video = false }: { src: string; alt: string; video?: boolean }) {
  const [scale, setScale] = useState(1);
  const changeScale = useCallback((delta: number) => setScale((current) => Math.min(4, Math.max(1, Number((current + delta).toFixed(2))))), []);
  function onWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    changeScale(event.deltaY < 0 ? 0.2 : -0.2);
  }
  const mediaStyle = { transform: `scale(${scale})` };
  return <div className="task-media-zoom" onWheel={onWheel}>
    {video ? <video src={src} controls preload="metadata" playsInline aria-label={alt} style={mediaStyle} /> : <img src={src} alt={alt} draggable={false} style={mediaStyle} />}
    <div className="task-zoom-controls" aria-label="预览缩放控制"><button type="button" className="icon-button" onClick={() => changeScale(-0.2)} disabled={scale <= 1} aria-label="缩小" title="缩小"><ZoomOut size={14} /></button><span>{Math.round(scale * 100)}%</span><button type="button" className="icon-button" onClick={() => changeScale(0.2)} disabled={scale >= 4} aria-label="放大" title="放大"><ZoomIn size={14} /></button><button type="button" className="icon-button" onClick={() => setScale(1)} disabled={scale === 1} aria-label="重置缩放" title="重置缩放"><ResetZoom size={14} /></button></div>
  </div>;
}
