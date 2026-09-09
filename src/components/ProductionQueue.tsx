'use client';

import Link from 'next/link';
import { CalendarDays, CheckCircle2, CircleAlert, Copy, Pause, Play, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatProviderError } from '@/lib/providers/errorMessages';
import { canonicalTaskProgress } from '@/lib/providers/taskProgress';

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
  errorInfo?: {
    code: string;
    category: string;
    title: string;
    message: string;
    action: string;
    safeToRetry: boolean;
  };
  provider?: string;
  providerTaskId?: string;
  schedulerState?: string;
  prompt?: string;
  promptProvider?: string;
  promptModel?: string;
  promptMode?: string;
  promptFallbackProviders?: string[];
  localOutputReady?: boolean;
  localOutputPending?: boolean;
  metadata?: Record<string, unknown>;
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

function promptProviderName(provider: string): string {
  const names: Record<string, string> = {
    'pomoai-gpt-prompt': 'PomoAI',
    'oairegbox-gpt-prompt': 'OAIRegBox',
    'bigsnake-prompt': 'BigSnake',
    'gpt-2999-prompt': 'GPT-2999',
    'yuanai-gemini-prompt': 'YuanAI Gemini',
  };
  const direct = names[provider];
  if (direct) return direct;
  const normalized = provider.trim().toLowerCase();
  if (normalized.includes('pomoai')) return 'PomoAI';
  if (normalized.includes('oairegbox')) return 'OAIRegBox';
  if (normalized.includes('bigsnake')) return 'BigSnake';
  if (normalized.includes('2999')) return 'GPT-2999';
  if (normalized.includes('yuanai')) return 'YuanAI';
  return provider;
}

function videoProviderName(provider?: string): string {
  const names: Record<string, string> = {
    'grok-video': 'Snumom',
    'yuanai-grok-video': 'YuanAI',
    'mgrouter-grok-video': 'MGRouter',
    'wan3-video': 'ManjuAI',
    'minimax-h3': 'secure-skill',
    'miku-minimax': 'MikuAPI',
    'pro666-video': 'Pro666',
    'quality-v4': 'crack.cc.cd',
    'oairegbox-omni': 'OAIRegBox',
    'mgrouter-grok-image': 'MGRouter',
    'yuanai-image': 'YuanAI',
    'aicloud-gpt-image': 'Aicloud',
    'pomoai-gemini-image': 'PomoAI',
    'origin-gpt-image': 'OriginGateway',
    'origin-grok-image': 'OriginGateway',
    'origin-nano-image': 'OriginGateway',
    'junze-gpt-image': 'Junze',
    'junze-gemini-image': 'Junze',
  };
  if (!provider) return 'Unknown provider';
  const direct = names[provider];
  if (direct) return direct;
  const normalized = provider.trim().toLowerCase();
  if (normalized.includes('yuanai')) return 'YuanAI';
  if (normalized.includes('mgrouter')) return 'MGRouter';
  if (normalized.includes('manjuai')) return 'ManjuAI';
  if (normalized.includes('secure-skill')) return 'secure-skill';
  if (normalized.includes('miku')) return 'MikuAPI';
  if (normalized.includes('pro666')) return 'Pro666';
  if (normalized.includes('oairegbox')) return 'OAIRegBox';
  if (normalized.includes('snumom') || normalized.includes('grok')) return 'Snumom';
  return provider;
}

export function generationAttributionLabel(task: Pick<QueueTask, 'mode' | 'provider' | 'model'>): string {
  const model = task.model || task.provider || 'Unknown model';
  if (task.mode === 'video') return `${videoProviderName(task.provider)} · ${model}`;
  if (task.mode === 'image' && task.provider) return `${videoProviderName(task.provider)} · ${model}`;
  return model;
}

export function promptAttributionLabel(task: Pick<QueueTask, 'promptMode' | 'promptProvider' | 'promptModel'>): string {
  if (task.promptMode === 'manual') return '手写';
  if (!task.promptProvider) return task.promptModel ? task.promptModel : '提示词未生成';
  return `${promptProviderName(task.promptProvider)}${task.promptModel ? ` · ${task.promptModel}` : ''}`;
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
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [recovering, setRecovering] = useState(false);
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
      const normalized = raw.map((task) => {
        const metadata = task.metadata;
        const localOutputReady = Boolean(metadata && metadata.localOutputReady === true);
        const localOutputCount = metadata && typeof metadata.localOutputCount === 'number' ? metadata.localOutputCount : undefined;
        const localOutputExpected = metadata && typeof metadata.localOutputExpected === 'number' ? metadata.localOutputExpected : undefined;
        const localOutputPending = localOutputExpected !== undefined && localOutputCount !== undefined && localOutputCount < localOutputExpected;
        const schedulerState = task.schedulerState ?? (typeof metadata?.schedulerState === 'string' ? metadata.schedulerState : undefined);
        const providerTaskId = task.providerTaskId;
        const promptGenerationPending = metadata?.promptGenerationPending === true;
        return {
          ...task,
          progress: canonicalTaskProgress({ mode: task.mode, status: task.status, progress: task.progress, providerTaskId, schedulerState, promptGenerationPending, localOutputReady, localOutputPending }),
          promptProvider: task.promptProvider ?? (typeof metadata?.promptProvider === 'string' ? metadata.promptProvider : undefined),
          promptModel: task.promptModel ?? (typeof metadata?.promptModel === 'string' ? metadata.promptModel : undefined),
          promptMode: task.promptMode ?? (typeof metadata?.promptMode === 'string' ? metadata.promptMode : undefined),
          promptFallbackProviders: task.promptFallbackProviders ?? (Array.isArray(metadata?.promptFallbackProviders) ? metadata.promptFallbackProviders.filter((value): value is string => typeof value === 'string') : undefined),
          localOutputReady,
          localOutputPending,
          schedulerState,
        };
      });
      const deduped = Array.from(new Map(normalized.map((task) => [task.id, task])).values());
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
  const safeRecoverable = useMemo(() => dated.filter((task) => task.status === 'failed' && task.errorInfo?.safeToRetry), [dated]);
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

  async function recoverSafeTasks() {
    if (recovering || !safeRecoverable.length || mode === 'prompt') return;
    setRecovering(true);
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/generate-video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'recover-safe', date: queueDate }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: { recovered?: number; started?: number; skipped?: number; batchId?: string } } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'safe_recovery_failed');
      const recovered = payload.data?.recovered;
      const started = payload.data?.started ?? 0;
      const skipped = payload.data?.skipped ?? 0;
      setMessage(recovered === undefined
        ? `已开始恢复 ${started} 条可安全重试的任务${skipped ? `，跳过 ${skipped} 条需要人工确认的任务` : ''}`
        : `已恢复 ${recovered} 条可安全重试的任务${skipped ? `，跳过 ${skipped} 条需要人工确认的任务` : ''}`);
      await load({ sync: true });
    } catch (error) {
      setMessage(formatProviderError(error instanceof Error ? error.message : 'safe_recovery_failed'));
    } finally {
      setRecovering(false);
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

  async function openPrompt(task: QueueTask) {
    setPromptTask(task);
    setPromptCopied(false);
    setPromptLoading(true);
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(task.accountId)}/${taskEndpoint(mode)}/${encodeURIComponent(task.id)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: QueueTask & { prompt?: string } } | null;
      const prompt = response.ok && payload?.success && typeof payload.data?.prompt === 'string' ? payload.data.prompt : '';
      setPromptTask((current) => current?.id === task.id ? { ...current, prompt } : current);
    } catch {
      setPromptTask((current) => current?.id === task.id ? { ...current, prompt: '' } : current);
    } finally {
      setPromptLoading(false);
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
        {!readOnly && mode !== 'prompt' && safeRecoverable.length > 0 && <button type="button" className="queue-recover-safe" onClick={() => void recoverSafeTasks()} disabled={recovering}>{recovering ? <RefreshCw size={13} className="spin" /> : <RotateCcw size={13} />} {recovering ? '正在恢复…' : `一键恢复 ${safeRecoverable.length} 条安全任务`}</button>}
      </div>
      {message && <div className="production-queue-message" role="status">{message}</div>}
      {loadError && <div className="production-queue-message queue-error" role="alert"><CircleAlert size={13} />{loadError}</div>}
      <div className="production-queue-list">
        {loading && <div className="asset-empty">正在加载队列…</div>}
        {!loading && !loadError && !visible.length && <div className="asset-empty">{queueTab === 'all' ? '当天暂无生产任务' : queueTab === 'active' ? '暂无进行中的任务' : queueTab === 'completed' ? '暂无已完成任务' : '暂无失败任务'}</div>}
        {visible.map((task) => <article className={`production-queue-item ${focusedTaskId === task.id ? 'queue-item-focused' : ''}`} id={`queue-task-${task.id}`} key={task.id}>
          <div className="production-queue-item-top"><div><strong>{task.title}</strong>{task.accountName && <small className="queue-account-name">{task.accountName}</small>}<span className="queue-model-line"><b>{task.mode === 'prompt' ? promptAttributionLabel(task) : generationAttributionLabel(task)}</b>{task.mode !== 'prompt' && <><span>·</span><b>{promptAttributionLabel(task)}</b></>}<time>{new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></span></div><span className={`status ${task.status === 'failed' ? 'attention' : ''}`}><span className="dot" />{queueStatusLabel(task)}</span></div>
          <div className="production-queue-progress"><div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div><span>{['processing', 'running', 'prompting', 'submitting', 'submitted'].includes(task.status) ? `生成中 · ${task.progress}%` : `${task.progress}%`}</span>{task.inventorySavedAt && <span className="queue-inventory"><CheckCircle2 size={13} /> 已入库</span>}{task.status === 'completed' && !task.inventorySavedAt && <span className="queue-unsaved">未入库</span>}</div>
          {task.error && <div className="queue-error"><CircleAlert size={13} /><div><strong>{task.errorInfo?.title ?? formatProviderError(task.error)}</strong>{task.errorInfo?.message && <span>{task.errorInfo.message}</span>}{task.errorInfo?.action && <small>{task.errorInfo.action}</small>}<em>{task.errorInfo?.safeToRetry ? '可安全恢复' : '需要修改配置或人工确认后重试'}</em></div></div>}
          {task.promptMode !== 'manual' && task.promptFallbackProviders?.length ? <div className="queue-prompt-provider">提示词已自动退避，最终使用 {promptAttributionLabel(task)}</div> : null}
          <div className="production-queue-actions">
             <Link href={reviewHref(task.accountId, mode, task.id)} className="queue-link">{mode === 'prompt' ? '恢复配置' : '审核'}</Link>
              {mode !== 'prompt' && <button type="button" className="queue-link" onClick={() => void openPrompt(task)}>提示词</button>}
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
        <pre className="queue-prompt-content">{promptLoading ? '正在加载提示词…' : promptTask.prompt || '该任务没有保存提示词'}</pre>
        <div className="modal-actions"><button type="button" className="primary-button" onClick={() => void copyPrompt()} disabled={!promptTask.prompt}><Copy size={14} /> {promptCopied ? '已复制' : '复制'}</button><button type="button" className="ghost-button" onClick={() => setPromptTask(null)}>关闭</button></div>
      </section>
    </div>}
    </>
  );
}
