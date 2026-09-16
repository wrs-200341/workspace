'use client';

import Link from 'next/link';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Copy, Pause, Play, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatProviderError } from '@/lib/providers/errorMessages';
import { canonicalTaskProgress } from '@/lib/providers/taskProgress';
import { mergeQueueDelta, type QueueCounts, type QueueDelta, type QueueTab } from '@/lib/workspace/queueProtocol';

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
  promptGenerationUsedTemplate?: boolean;
  localOutputReady?: boolean;
  localOutputPending?: boolean;
  metadata?: Record<string, unknown>;
};

type Props = { accountId: string; mode: 'video' | 'image' | 'prompt'; focusTaskId?: string; queueDate?: string; readOnly?: boolean; ownerId?: string; viewerKey?: string };
type FocusRequest = { taskId?: string; unstored?: boolean };
type QueueSnapshot = Omit<QueueDelta<QueueTask>, 'deletedTaskIds' | 'reset'> & { key: string; scrollY: number; savedAt: number };
type QueuePreference = { date: string; tab: QueueTab; page: number; focus: FocusRequest; savedAt: number };
const queueMemory = new Map<string, QueueSnapshot>();
const queuePreferences = new Map<string, QueuePreference>();
const QUEUE_CACHE_TTL = 5 * 60_000;
const EMPTY_COUNTS: QueueCounts = { all: 0, active: 0, completed: 0, failed: 0, unsaved: 0, safeRecoverable: 0 };

function rememberQueue(key: string, snapshot: QueueSnapshot) {
  queueMemory.delete(key);
  queueMemory.set(key, snapshot);
  while (queueMemory.size > 16) queueMemory.delete(queueMemory.keys().next().value!);
}

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
    'secure-skill-gpt-prompt': 'secure-skill',
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
    'wan-3-nsfw': '808relay',
    'apiaw-seedance-video': 'apiaw',
    'dola-sd2': 'yuansucang',
    seedream: 'apiaw',
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
  const model = task.model === 'dola-sd2' ? 'dola sd2' : task.model || task.provider || 'Unknown model';
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

function normalizeQueueTasks(raw: QueueTask[]): QueueTask[] {
  const normalized = raw.map((task) => {
    const metadata = task.metadata;
    const localOutputReady = task.localOutputReady ?? Boolean(metadata && metadata.localOutputReady === true);
    const localOutputCount = metadata && typeof metadata.localOutputCount === 'number' ? metadata.localOutputCount : undefined;
    const localOutputExpected = metadata && typeof metadata.localOutputExpected === 'number' ? metadata.localOutputExpected : undefined;
    const localOutputPending = task.localOutputPending ?? (localOutputExpected !== undefined && localOutputCount !== undefined && localOutputCount < localOutputExpected);
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
      promptGenerationUsedTemplate: task.promptGenerationUsedTemplate ?? (metadata?.promptGenerationUsedTemplate === true),
      localOutputReady,
      localOutputPending,
      schedulerState,
    };
  });
  return Array.from(new Map(normalized.map((task) => [task.id, task])).values())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function ProductionQueue({ accountId, mode, focusTaskId: requestedFocusTaskId, queueDate: requestedQueueDate, readOnly = false, ownerId, viewerKey }: Props) {
  const requestedDate = requestedQueueDate;
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [queueDate, setQueueDate] = useState(() => requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : today());
  const [queueTab, setQueueTab] = useState<QueueTab>('all');
  const [page, setPage] = useState(0);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>({ taskId: requestedFocusTaskId });
  const [loadedCounts, setCounts] = useState<QueueCounts>(EMPTY_COUNTS);
  const [pagination, setPagination] = useState({ page: 0, totalPages: 1 });
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
  const snapshotRef = useRef<QueueSnapshot | null>(null);
  const scrollPositionRef = useRef(0);
  const restoreScrollRef = useRef<number | null>(null);
  const cacheRoot = JSON.stringify([viewerKey, accountId, ownerId, mode, readOnly]);
  const viewKey = JSON.stringify([cacheRoot, queueDate, queueTab, page, focusRequest]);
  const currentViewRef = useRef(viewKey);
  currentViewRef.current = viewKey;
  const counts = snapshotRef.current?.key === viewKey ? loadedCounts : EMPTY_COUNTS;

  function saveNavigation() {
    const snapshot = snapshotRef.current;
    if (!viewerKey || snapshot?.key !== viewKey) return;
    const savedAt = Date.now();
    scrollPositionRef.current = window.scrollY;
    rememberQueue(viewKey, { ...snapshot, scrollY: window.scrollY, savedAt });
    queuePreferences.delete(cacheRoot);
    queuePreferences.set(cacheRoot, { date: queueDate, tab: queueTab, page, focus: focusRequest, savedAt });
    while (queuePreferences.size > 16) queuePreferences.delete(queuePreferences.keys().next().value!);
  }

  useEffect(() => {
    if (!viewerKey) return;
    const preference = queuePreferences.get(cacheRoot);
    if (!preference || Date.now() - preference.savedAt > QUEUE_CACHE_TTL) return;
    if (requestedDate && requestedDate !== preference.date) return;
    setQueueDate(requestedDate || preference.date);
    if (!requestedFocusTaskId) {
      setQueueTab(preference.tab);
      setPage(preference.page);
      setFocusRequest(preference.focus);
    }
  }, [cacheRoot, viewerKey, requestedDate, requestedFocusTaskId]);

  useEffect(() => {
    if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) setQueueDate(requestedDate);
    if (requestedFocusTaskId) {
      focusAppliedRef.current = null;
      setQueueTab('all');
      setPage(0);
      setFocusRequest({ taskId: requestedFocusTaskId });
    }
  }, [requestedDate, requestedFocusTaskId]);

  async function load(options: { silent?: boolean; sync?: boolean } = {}) {
    const silent = options.silent === true;
    if (currentViewRef.current !== viewKey || document.hidden || (silent && loadingRef.current)) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    loadingRef.current = true;
    if (!silent && snapshotRef.current?.key !== viewKey) setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams({ date: queueDate, scope: 'owner', queue: 'delta', tab: queueTab, page: String(page), limit: '50' });
      if (ownerId) params.set('ownerId', ownerId);
      if (focusRequest.taskId) params.set('focusTaskId', focusRequest.taskId);
      if (focusRequest.unstored) params.set('focusUnstored', '1');
      const previous = snapshotRef.current?.key === viewKey ? snapshotRef.current : null;
      if (previous?.token) params.set('since', previous.token);
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/${taskEndpoint(mode)}?${params.toString()}`, { cache: 'no-store', signal: controller.signal });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: QueueDelta<QueueTask> } | null;
      if (controller.signal.aborted || currentViewRef.current !== viewKey) return;
      if (response.status === 401 || response.status === 403) {
        queueMemory.clear();
        queuePreferences.clear();
        snapshotRef.current = null;
        setTasks([]);
        setCounts(EMPTY_COUNTS);
      }
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '队列加载失败');
      const delta = payload.data;
      if (!delta || !Array.isArray(delta.tasks) || typeof delta.token !== 'string' || !delta.counts) throw new Error('queue_response_invalid');
      const nextTasks = mergeQueueDelta(previous?.tasks ?? [], { ...delta, tasks: normalizeQueueTasks(delta.tasks) });
      const snapshot: QueueSnapshot = { ...delta, tasks: nextTasks, key: viewKey, scrollY: previous?.scrollY ?? 0, savedAt: Date.now() };
      snapshotRef.current = snapshot;
      if (viewerKey) rememberQueue(viewKey, snapshot);
      setTasks(nextTasks);
      setCounts((current) => JSON.stringify(current) === JSON.stringify(delta.counts) ? current : delta.counts);
      setPagination((current) => current.page === delta.page && current.totalPages === delta.totalPages ? current : { page: delta.page, totalPages: delta.totalPages });
    } catch (error) {
      if (controller.signal.aborted || currentViewRef.current !== viewKey) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLoadError(error instanceof Error ? error.message : '队列加载失败');
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const cached = viewerKey ? queueMemory.get(viewKey) : undefined;
    const snapshot = cached && Date.now() - cached.savedAt <= QUEUE_CACHE_TTL ? cached : null;
    snapshotRef.current = snapshot;
    setTasks(snapshot?.tasks ?? []);
    setCounts(snapshot?.counts ?? EMPTY_COUNTS);
    setPagination({ page: snapshot?.page ?? 0, totalPages: snapshot?.totalPages ?? 1 });
    setLoading(!snapshot);
    restoreScrollRef.current = snapshot?.scrollY ?? null;
    if (snapshot) focusAppliedRef.current = focusRequest.taskId || (focusRequest.unstored ? 'unsaved' : null);
    loadingRef.current = false;
    void load({ silent: Boolean(snapshot) });
    const timer = window.setInterval(() => void load({ silent: true }), 8000);
    const onVisibility = () => {
      if (document.hidden) {
        requestRef.current?.abort();
        return;
      }
      void load({ silent: true });
    };
    const onScroll = () => { scrollPositionRef.current = window.scrollY; };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', onScroll);
      requestRef.current?.abort();
      const current = snapshotRef.current;
      if (viewerKey && current?.key === viewKey) {
        const savedAt = Date.now();
        rememberQueue(viewKey, { ...current, scrollY: scrollPositionRef.current, savedAt });
        queuePreferences.delete(cacheRoot);
        queuePreferences.set(cacheRoot, { date: queueDate, tab: queueTab, page, focus: focusRequest, savedAt });
        while (queuePreferences.size > 16) queuePreferences.delete(queuePreferences.keys().next().value!);
      }
    };
  }, [viewKey]);

  useEffect(() => {
    if (loading || restoreScrollRef.current === null) return;
    const y = restoreScrollRef.current;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: y, behavior: 'instant' });
      restoreScrollRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, tasks, focusRequest]);

  useEffect(() => {
    const focusTaskId = focusRequest.taskId;
    const focusKey = focusTaskId || (focusRequest.unstored ? 'unsaved' : '');
    if (!focusKey || loading || focusAppliedRef.current === focusKey) return;
    const target = tasks.find((task) => focusTaskId ? task.id === focusTaskId : task.status === 'completed' && !task.inventorySavedAt);
    if (!target) return;
    focusAppliedRef.current = focusKey;
    setFocusedTaskId(target.id);
    const timer = window.setTimeout(() => document.getElementById(`queue-task-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return () => window.clearTimeout(timer);
  }, [focusRequest, loading, tasks]);

  const dated = useMemo(
    () => snapshotRef.current?.key === viewKey ? tasks.filter((task) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(task.createdAt)) === queueDate) : [],
    [tasks, queueDate, viewKey],
  );
  const visible = useMemo(() => {
    if (queueTab === 'all') return dated;
    if (queueTab === 'active') return dated.filter((task) => isActive(task.status));
    return dated.filter((task) => task.status === queueTab);
  }, [dated, queueTab]);

  function jumpToUnstored() {
    if (!counts.unsaved) return;
    focusAppliedRef.current = null;
    setQueueTab('all');
    setPage(0);
    setFocusRequest({ unstored: true });
  }

  async function action(task: QueueTask, actionName: string) {
    try {
      const endpoint = taskEndpoint(mode);
      const response = actionName === 'delete'
        ? await fetch(`/api/workspace/accounts/${encodeURIComponent(task.accountId)}/${endpoint}/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
        : await fetch(`/api/workspace/accounts/${encodeURIComponent(task.accountId)}/${endpoint}/${encodeURIComponent(task.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }) });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '队列操作失败');
      setMessage(actionName === 'retry' ? '任务已重新进入队列' : actionName === 'delete' ? '任务已从生产队列删除' : actionName === 'recover-provider' ? '已查询上游结果并更新队列' : '队列状态已更新');
      await load();
    } catch (error) {
      setMessage(formatProviderError(error instanceof Error ? error.message : '队列操作失败'));
    }
  }

  async function recoverSafeTasks() {
    if (recovering || !counts.safeRecoverable || mode === 'prompt') return;
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
        <div className="production-queue-tools"><label><CalendarDays size={14} /><span className="sr-only">按日期筛选生产任务</span><input type="date" value={queueDate} onChange={(event) => { if (!event.target.value) return; setQueueDate(event.target.value); setPage(0); setFocusRequest({}); }} /></label><button type="button" className="icon-button" onClick={() => void load()} aria-label="刷新生产队列" title="刷新生产队列"><RefreshCw size={14} /></button><strong>{counts[queueTab]}</strong></div>
      </header>
      <div className="production-queue-tabs" role="tablist">
        {(['all', 'active', 'completed', 'failed'] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={queueTab === tab} className={queueTab === tab ? 'active' : ''} onClick={() => { setQueueTab(tab); setPage(0); setFocusRequest({}); }}>{tab === 'all' ? '全部' : tab === 'active' ? '进行中' : tab === 'completed' ? '完成' : '失败'}<span>{counts[tab]}</span></button>)}
        {counts.unsaved > 0 && <button type="button" className="queue-unsaved-link" onClick={jumpToUnstored}>未入库 {counts.unsaved} 条 · 跳转</button>}
        {!readOnly && mode !== 'prompt' && counts.safeRecoverable > 0 && <button type="button" className="queue-recover-safe" onClick={() => void recoverSafeTasks()} disabled={recovering}>{recovering ? <RefreshCw size={13} className="spin" /> : <RotateCcw size={13} />} {recovering ? '正在恢复…' : `一键恢复 ${counts.safeRecoverable} 条安全任务`}</button>}
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
          {task.promptMode !== 'manual' && task.promptGenerationUsedTemplate ? <div className="queue-prompt-provider queue-prompt-warning">未能生成子提示词，已使用模板提示词</div> : null}
          <div className="production-queue-actions">
             <Link href={reviewHref(task.accountId, mode, task.id)} className="queue-link" prefetch={false} onClick={saveNavigation}>{mode === 'prompt' ? '恢复配置' : '审核'}</Link>
              {mode !== 'prompt' && <button type="button" className="queue-link" onClick={() => void openPrompt(task)}>提示词</button>}
            {!readOnly && mode !== 'prompt' && <>{['queued', 'prompting', 'submitting', 'submitted', 'running', 'processing'].includes(task.status) && <button type="button" onClick={() => void action(task, 'pause')}><Pause size={13} /> 暂停</button>}{task.status === 'paused' && <button type="button" onClick={() => void action(task, 'resume')}><Play size={13} /> 继续</button>}</>}
             {!readOnly && mode === 'video' && task.status === 'failed' && task.error === 'provider_task_stale' && task.providerTaskId && <button type="button" onClick={() => void action(task, 'recover-provider')}><RefreshCw size={13} /> 查询上游结果</button>}
             {!readOnly && mode !== 'prompt' && (task.status === 'failed' || task.status === 'cancelled') && <Link href={restoreHref(task.accountId, mode, task.id)} className="queue-link" prefetch={false} onClick={saveNavigation}><RotateCcw size={13} /> 恢复配置</Link>}
             {!readOnly && mode !== 'prompt' && <button type="button" onClick={() => void action(task, 'delete')} disabled={!['completed', 'failed', 'cancelled'].includes(task.status)} title={!['completed', 'failed', 'cancelled'].includes(task.status) ? '任务完成或失败后可删除' : '删除任务'}><Trash2 size={13} /> 删除</button>}
            {!readOnly && ACTIONABLE_ACTIVE_STATUSES.includes(task.status as (typeof ACTIONABLE_ACTIVE_STATUSES)[number]) && <button type="button" onClick={() => void action(task, 'cancel')}><Trash2 size={13} /> 取消</button>}
          </div>
        </article>)}
      </div>
      {pagination.totalPages > 1 && <nav className="production-queue-tools" aria-label="队列分页" style={{ justifyContent: 'flex-end', padding: '12px 0', gap: 12 }}>
        <button type="button" className="icon-button" aria-label="上一页" title="上一页" disabled={loading || pagination.page === 0} onClick={() => { setPage(pagination.page - 1); setFocusRequest({}); }}><ChevronLeft size={16} /></button>
        <span style={{ minWidth: 76, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{pagination.page + 1} / {pagination.totalPages}</span>
        <button type="button" className="icon-button" aria-label="下一页" title="下一页" disabled={loading || pagination.page + 1 >= pagination.totalPages} onClick={() => { setPage(pagination.page + 1); setFocusRequest({}); }}><ChevronRight size={16} /></button>
      </nav>}
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
