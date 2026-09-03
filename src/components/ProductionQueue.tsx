'use client';

import Link from 'next/link';
import { CalendarDays, CheckCircle2, CircleAlert, Film, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
};

type Props = { accountId: string; mode: 'video' | 'image' | 'prompt' };
type QueueTab = 'all' | 'active' | 'completed' | 'failed';

const labels: Record<string, string> = {
  queued: '排队中', prompting: '提示词中', submitting: '提交中', submitted: '已提交',
  processing: '生成中', running: '处理中', completed: '已完成', failed: '失败',
  paused: '已暂停', cancelled: '已取消', draft: '草稿',
};
const ACTIVE_STATUSES = ['draft', 'queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'paused'] as const;
const ACTIONABLE_ACTIVE_STATUSES = ['queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'paused'] as const;
const isActive = (status: string) => ACTIVE_STATUSES.includes(status as (typeof ACTIVE_STATUSES)[number]);

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

export function ProductionQueue({ accountId, mode }: Props) {
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [queueDate, setQueueDate] = useState(today());
  const [queueTab, setQueueTab] = useState<QueueTab>('all');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);

  async function load(options: { silent?: boolean } = {}) {
    const silent = options.silent === true;
    if (!silent) setLoading(true);
    setLoadError('');
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/${taskEndpoint(mode)}?scope=owner&date=${encodeURIComponent(queueDate)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: { tasks?: QueueTask[] } | QueueTask[]; tasks?: QueueTask[] } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '队列加载失败');
      const raw = Array.isArray(payload.data) ? payload.data : payload.data?.tasks ?? payload.tasks ?? [];
      const deduped = Array.from(new Map(raw.map((task) => [task.id, task])).values());
      setTasks(deduped.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '队列加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Poll frequently while a task is being submitted/processed so progress
    // appears in the queue without waiting for a long spinner cycle. The
    // endpoint remains lightweight (read-only, no provider call for mock
    // tasks); a short interval also keeps live-provider status changes visible
    // shortly after the provider updates them.
    const timer = window.setInterval(() => void load({ silent: true }), 2000);
    return () => window.clearInterval(timer);
  }, [accountId, mode, queueDate]);

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
      setMessage(actionName === 'retry' ? '任务已重新进入队列' : actionName === 'save-inventory' ? '成品已存入素材资产' : actionName === 'delete' ? '任务已从生产队列删除' : '队列状态已更新');
      await load();
    } catch (error) {
      setMessage(formatProviderError(error instanceof Error ? error.message : '队列操作失败'));
    }
  }

  return (
    <section className="panel production-queue-panel">
      <header className="production-queue-header">
        <div><span className="eyebrow">PRODUCTION QUEUE</span><h2>生产队列</h2><p>按上海时间汇总当前运营账号下全部工作区的任务。</p></div>
        <div className="production-queue-tools"><label><CalendarDays size={14} /><span className="sr-only">按日期筛选生产任务</span><input type="date" value={queueDate} onChange={(event) => setQueueDate(event.target.value)} /></label><strong>{visible.length}</strong></div>
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
          <div className="production-queue-item-top"><div><strong>{task.title}</strong>{task.accountName && <small className="queue-account-name">{task.accountName}</small>}<span>{task.provider || task.model} · {new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div><span className={`status ${task.status === 'failed' ? 'attention' : ''}`}><span className="dot" />{labels[task.status] || task.status}</span></div>
          <div className="production-queue-progress"><div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div><span>{['processing', 'running', 'prompting', 'submitting', 'submitted'].includes(task.status) ? `生成中 · ${task.progress}%` : `${task.progress}%`}</span>{task.inventorySavedAt && <span className="queue-inventory"><CheckCircle2 size={13} /> 已入库</span>}{task.status === 'completed' && !task.inventorySavedAt && <span className="queue-unsaved">未入库</span>}</div>
          {task.error && <div className="queue-error"><CircleAlert size={13} />{formatProviderError(task.error)}</div>}
          <div className="production-queue-actions">
             <Link href={reviewHref(task.accountId, mode, task.id)} className="queue-link">{mode === 'prompt' ? '恢复配置' : '审核'}</Link>
             {mode !== 'prompt' && <Link href={promptReviewHref(task.accountId, mode, task.id)} className="queue-link">提示词</Link>}
            {mode !== 'prompt' && <>{['queued', 'prompting', 'submitting', 'submitted', 'running', 'processing'].includes(task.status) && <button type="button" onClick={() => void action(task, 'pause')}><Pause size={13} /> 暂停</button>}{task.status === 'paused' && <button type="button" onClick={() => void action(task, 'resume')}><Play size={13} /> 继续</button>}{task.status === 'completed' && !task.inventorySavedAt && <button type="button" onClick={() => void action(task, 'save-inventory')}><Film size={13} /> 存库</button>}</>}
             {mode !== 'prompt' && (task.status === 'failed' || task.status === 'cancelled') && <Link href={restoreHref(task.accountId, mode, task.id)} className="queue-link"><RotateCcw size={13} /> 恢复配置</Link>}
             {mode !== 'prompt' && <button type="button" onClick={() => void action(task, 'delete')} disabled={!['completed', 'failed', 'cancelled'].includes(task.status)} title={!['completed', 'failed', 'cancelled'].includes(task.status) ? '任务完成或失败后可删除' : '删除任务'}><Trash2 size={13} /> 删除</button>}
            {ACTIONABLE_ACTIVE_STATUSES.includes(task.status as (typeof ACTIONABLE_ACTIVE_STATUSES)[number]) && <button type="button" onClick={() => void action(task, 'cancel')}><Trash2 size={13} /> 取消</button>}
          </div>
        </article>)}
      </div>
    </section>
  );
}
