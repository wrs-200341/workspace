'use client';

import Link from 'next/link';
import { CalendarDays, CheckCircle2, CircleAlert, Copy, Pause, Play, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatProviderError } from '@/lib/providers/errorMessages';

type QueueTask = {
  id: string;
  accountId: string;
  accountName?: string;
  mode: 'video' | 'image' | 'prompt';
  title: string;
  model: string;
  status: string;
  progress: number;
  createdAt: string;
  inventorySavedAt?: string;
  error?: string;
  provider?: string;
  providerTaskId?: string;
  schedulerState?: string;
  prompt?: string;
};

type Props = { accountId: string; mode: 'video' | 'image' | 'prompt'; focusTaskId?: string; queueDate?: string; readOnly?: boolean; ownerId?: string };
type QueueTab = 'all' | 'active' | 'completed' | 'failed';

const labels: Record<string, string> = {
  retrying: '重试中',
  queued: '排队中', prompting: '提示词生成中', submitting: '提交中', submitted: '已提交',
  processing: '生成中', running: '处理中', completed: '已完成', failed: '失败',
  paused: '已暂停', cancelled: '已取消', draft: '草稿',
};
const ACTIVE_STATUSES = ['draft', 'queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'retrying', 'paused'] as const;
const ACTIONABLE_ACTIVE_STATUSES = ['queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'retrying', 'paused'] as const;
const isActive = (status: string) => ACTIVE_STATUSES.includes(status as (typeof ACTIVE_STATUSES)[number]);

/** A queued task may already be submitted upstream. Keep that distinct from
 * work waiting for one of this operator's local five-model slots. */
export function queueStatusLabel(task: Pick<QueueTask, 'status' | 'schedulerState' | 'providerTaskId'>): string {
  if (task.status === 'queued') {
    return task.schedulerState === 'provider-active' || Boolean(task.providerTaskId)
      ? '供应商排队中'
      : '本地排队中';
  }
  return labels[task.status] || task.status;
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function taskEndpoint(mode: Props['mode']) {
  return mode === 'video' ? 'video-tasks' : mode === 'image' ? 'image-tasks' : 'prompt-tasks';
}

function restoreHref(accountId: string, mode: Props['mode'], taskId: string) {
  return `/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${encodeURIComponent(mode)}&restoreTaskId=${encodeURIComponent(taskId)}`;
}

export function reviewHref(accountId: string, mode: Props['mode'], taskId: string): string {
  if (mode === 'prompt') return restoreHref(accountId, mode, taskId);
  return `/workspace/accounts/${encodeURIComponent(accountId)}/production/${mode}-tasks/${encodeURIComponent(taskId)}`;
}

export function promptReviewHref(accountId: string, mode: Props['mode'], taskId: string): string {
  return mode === 'prompt' ? restoreHref(accountId, mode, taskId) : `${reviewHref(accountId, mode, taskId)}#prompt`;
}

export function ProductionQueue({ accountId, mode, focusTaskId: requestedFocusTaskId, queueDate: requestedQueueDate, readOnly = false, ownerId }: Props) {
  const focusTaskId = requestedFocusTaskId;
  const requestedDate = requestedQueueDate;
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [queueDate, setQueueDate] = useState(() => requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : today());
  const [queueTab, setQueueTab] = useState<QueueTab>('all');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [promptTask, setPromptTask] = useState<QueueTask | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const focusAppliedRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);

  async function load(options: { silent?: boolean; sync?: boolean } = {}) {
    const silent = options.silent === true;
    if (silent && loadingRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    loadingRef.current = true;
    if (!silent) setLoading(true);
    setLoadError('');
    try {
      const sync = options.sync === true ? '&sync=1' : '';
      const scope = `&scope=owner${ownerId ? `&ownerId=${encodeURIComponent(ownerId)}` : ''}`;
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/${taskEndpoint(mode)}?date=${encodeURIComponent(queueDate)}${scope}${sync}`, { cache: 'no-store', signal: controller.signal });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: { tasks?: QueueTask[] } | QueueTask[]; tasks?: QueueTask[] } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '队列加载失败');
      const raw = Array.isArray(payload.data) ? payload.data : payload.data?.tasks ?? payload.tasks ?? [];
      const deduped = Array.from(new Map(raw.map((task) => [task.id, task])).values());
      setTasks(deduped.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLoadError(error instanceof Error ? error.message : '队列加载失败');
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        loadingRef.current = false;
        if (!silent) setLoading(false);
      }
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load({ silent: true, sync: true }), 8000);
    return () => {
      window.clearInterval(timer);
      requestRef.current?.abort();
    };
  }, [accountId, mode, queueDate]);

  useEffect(() => {
    if (!focusTaskId || loading || focusAppliedRef.current === focusTaskId) return;
    const target = tasks.find((task) => task.id === focusTaskId);
    if (!target) return;
    focusAppliedRef.current = focusTaskId;
    setQueueTab('all');
    setFocusedTaskId(target.id);
    const timer = window.setTimeout(() => document.getElementById(`queue-task-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return () => window.clearTimeout(timer);
  }, [focusTaskId, loading, tasks]);

  const dated = useMemo(
    () => tasks.filter((task) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(task.createdAt)) === queueDate),
    [tasks, queueDate],
  );
  const unsaved = useMemo(() => mode === 'video' ? dated.filter((task) => task.status === 'completed' && !task.inventorySavedAt) : [], [dated, mode]);
  const counts = useMemo(() => ({
    all: dated.length,
    active: dated.filter((task) => isActive(task.status)).length,
    completed: dated.filter((task) => task.status === 'completed').length,
    failed: dated.filter((task) => task.status === 'failed').length,
  }), [dated]);
  const visible = useMemo(() => {
    if (queueTab === 'all') return dated;
    if (queueTab === 'active') return dated.filter((task) => isActive(task.status));
    return dated.filter((task) => task.status === queueTab);
  }, [dated, queueTab]);

  function jumpToUnstored() {
    const target = unsaved[0];
    if (!target) return;
    setQueueTab('all');
    setFocusedTaskId(target.id);
    window.setTimeout(() => document.getElementById(`queue-task-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  async function action(task: QueueTask, actionName: string) {
    try {
      const endpoint = taskEndpoint(mode);
      const response = actionName === 'delete'
        ? await fetch(`/api/workspace/accounts/${encodeURIComponent(task.accountId)}/${endpoint}/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
        : await fetch(`/api/workspace/accounts/${encodeURIComponent(task.accountId)}/${endpoint}/${encodeURIComponent(task.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }) });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '队列操作失败');
      setMessage(actionName === 'retry' ? '任务已重新进入队列' : actionName === 'delete' ? '任务已从生产队列删除' : '队列状态已更新');
      await load();
    } catch (error) {
      setMessage(formatProviderError(error instanceof Error ? error.message : '队列操作失败'));
    }
  }

  async function copyPrompt() {
    if (!promptTask?.prompt) return;
    try {
      await navigator.clipboard.writeText(promptTask.prompt);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1600);
    } catch {
      setPromptCopied(false);
    }
  }

  return (
    <>
    <section className={`panel production-queue-panel ${readOnly ? 'read-only-queue' : ''}`}>
      <header className="production-queue-header">
        <div><span className="eyebrow">PRODUCTION QUEUE</span><h2>生产队列</h2><p>按上海时间汇总当前运营账号下全部工作区的任务。</p></div>
        <div className="production-queue-tools"><label><CalendarDays size={14} /><span className="sr-only">按日期筛选生产任务</span><input type="date" value={queueDate} onChange={(event) => setQueueDate(event.target.value)} /></label><button type="button" className="icon-button" onClick={() => void load({ sync: true })} aria-label="刷新生产队列" title="刷新生产队列"><RefreshCw size={14} /></button><strong>{visible.length}</strong></div>
      </header>
      <div className="production-queue-tabs" role="tablist">
        {(['all', 'active', 'completed', 'failed'] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={queueTab === tab} className={queueTab === tab ? 'active' : ''} onClick={() => setQueueTab(tab)}>{tab === 'all' ? '全部' : tab === 'active' ? '进行中' : tab === 'completed' ? '完成' : '失败'}<span>{counts[tab]}</span></button>)}
        {unsaved.length > 0 && <button type="button" className="queue-unsaved-link" onClick={jumpToUnstored}>未入库 {unsaved.length} 条 · 跳转</button>}
      </div>
      {message && <div className="production-queue-message" role="status">{message}</div>}
      {loadError && <div className="production-queue-message queue-error" role="alert"><CircleAlert size={13} />{loadError}</div>}
      <div className="production-queue-list">
        {loading && <div className="asset-empty">正在加载队列…</div>}
        {!loading && !loadError && !visible.length && <div className="asset-empty">{queueTab === 'all' ? '当天暂无生产任务' : queueTab === 'active' ? '暂无进行中的任务' : queueTab === 'completed' ? '暂无已完成任务' : '暂无失败任务'}</div>}
        {visible.map((task) => <article className={`production-queue-item ${focusedTaskId === task.id ? 'queue-item-focused' : ''}`} id={`queue-task-${task.id}`} key={task.id}>
          <div className="production-queue-item-top"><div><strong>{task.title}</strong>{task.accountName && <small className="queue-account-name">{task.accountName}</small>}<span>{task.provider || task.model} · {new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div><span className={`status ${task.status === 'failed' ? 'attention' : ''}`}><span className="dot" />{queueStatusLabel(task)}</span></div>
          <div className="production-queue-progress"><div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div><span>{['processing', 'running', 'prompting', 'submitting', 'submitted'].includes(task.status) ? `生成中 · ${task.progress}%` : `${task.progress}%`}</span>{task.inventorySavedAt && <span className="queue-inventory"><CheckCircle2 size={13} /> 已入库</span>}{task.status === 'completed' && !task.inventorySavedAt && <span className="queue-unsaved">未入库</span>}</div>
          {task.error && <div className="queue-error"><CircleAlert size={13} />{formatProviderError(task.error)}</div>}
          <div className="production-queue-actions">
             <Link href={reviewHref(task.accountId, mode, task.id)} className="queue-link">{mode === 'prompt' ? '恢复配置' : '审核'}</Link>
              {mode !== 'prompt' && <button type="button" className="queue-link" onClick={() => { setPromptTask(task); setPromptCopied(false); }}>提示词</button>}
            {!readOnly && mode !== 'prompt' && <>{['queued', 'prompting', 'submitting', 'submitted', 'running', 'processing'].includes(task.status) && <button type="button" onClick={() => void action(task, 'pause')}><Pause size={13} /> 暂停</button>}{task.status === 'paused' && <button type="button" onClick={() => void action(task, 'resume')}><Play size={13} /> 继续</button>}</>}
             {!readOnly && mode !== 'prompt' && (task.status === 'failed' || task.status === 'cancelled') && <Link href={restoreHref(task.accountId, mode, task.id)} className="queue-link"><RotateCcw size={13} /> 恢复配置</Link>}
             {!readOnly && mode !== 'prompt' && <button type="button" onClick={() => void action(task, 'delete')} disabled={!['completed', 'failed', 'cancelled'].includes(task.status)} title={!['completed', 'failed', 'cancelled'].includes(task.status) ? '任务完成或失败后可删除' : '删除任务'}><Trash2 size={13} /> 删除</button>}
            {!readOnly && ACTIONABLE_ACTIVE_STATUSES.includes(task.status as (typeof ACTIONABLE_ACTIVE_STATUSES)[number]) && <button type="button" onClick={() => void action(task, 'cancel')}><Trash2 size={13} /> 取消</button>}
          </div>
        </article>)}
      </div>
    </section>
    {promptTask && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPromptTask(null); }}>
      <section className="modal-card queue-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="queue-prompt-title">
        <div className="panel-header"><div><h2 id="queue-prompt-title" className="panel-title">任务提示词</h2><div className="panel-meta">{promptTask.title}</div></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setPromptTask(null)}><X size={15} /></button></div>
        <pre className="queue-prompt-content">{promptTask.prompt || '该任务没有保存提示词'}</pre>
        <div className="modal-actions"><button type="button" className="primary-button" onClick={() => void copyPrompt()} disabled={!promptTask.prompt}><Copy size={14} /> {promptCopied ? '已复制' : '复制'}</button><button type="button" className="ghost-button" onClick={() => setPromptTask(null)}>关闭</button></div>
      </section>
    </div>}
    </>
  );
}
