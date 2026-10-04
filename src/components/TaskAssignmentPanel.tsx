'use client';

import { ArrowRight, Check, ChevronDown, ChevronRight, ClipboardList, Copy, Download, Image as ImageIcon, ListPlus, LoaderCircle, MessageSquareText, Pencil, Plus, Search, Trash2, X, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser } from '@/lib/auth/policy';
import { getWorkspaceOperators } from '@/lib/workspace/data';
import type { TaskAssignment, TaskAssignmentProgress } from '@/lib/workspace/taskAssignments';

type CrawlType = 'clothing' | 'non_clothing';
type CrawlQueueResult = { requested: number; queued: number; completed: number; active: number };
type Draft = { id?: string; pid: string; source: 'tap' | 'cap'; crawlType: CrawlType; urgent: boolean; operatorId: string; quantity: string; quantities: Record<string, string> };
type BatchDraft = { pids: string; source: 'tap' | 'cap'; crawlType: CrawlType; urgent: boolean; quantities: Record<string, string> };
type FeedbackDraft = { id: string; pid: string; feedback: string };
type ApiPayload = { success?: boolean; data?: TaskAssignment; error?: string };
type SaveApiPayload = { success?: boolean; data?: TaskAssignment | TaskAssignment[]; crawl?: CrawlQueueResult; error?: string };
type BatchSaveApiPayload = { success?: boolean; data?: { created: TaskAssignment[]; createdPids: string[]; skippedPids: string[] }; crawl?: CrawlQueueResult; error?: string };
type ProgressApiPayload = { success?: boolean; data?: TaskAssignmentProgress[]; error?: string };
type PidCheckData = {
  pid: string;
  source: 'tap' | 'cap';
  canMount: boolean;
  reason: string;
  title?: string;
  price?: string;
  salesText?: string;
  commissionRate?: number;
  commissionAmount?: string;
};
type PidCheckApiPayload = { success?: boolean; data?: PidCheckData; error?: string };
type AssignmentRow = TaskAssignment & Partial<TaskAssignmentProgress>;
type AssignmentGroup = {
  pid: string;
  rows: AssignmentRow[];
  sourceLabel: string;
  urgent: boolean;
  quantity: number;
  pendingQuantity: number | null;
  tapSales: number | null | undefined;
  localOrders: number | null | undefined;
  productName: string | null | undefined;
  productPreviewUrl: string | null | undefined;
  productRating: number | null | undefined;
  commissionAmount: string | null | undefined;
  productStock: number | string | null | undefined;
  crawlStatus: TaskAssignmentProgress['crawlStatus'];
  crawlError: string | undefined;
};

const BATCH_OPERATOR_NAMES = new Set(['郭青青', '陈曦', '吴凤燕', '自莉', '美怡']);

function errorMessage(code: string | undefined): string {
  if (code === 'invalid_pid') return '请输入有效的 PID';
  if (code === 'operator_not_found') return '请选择运营人员';
  if (code === 'invalid_quantity') return '任务数量必须是 1 到 10000 的整数';
  if (code === 'invalid_source') return '请选择 TAP 或 CAP';
  if (code === 'invalid_urgent') return '加急状态无效，请重新选择';
  if (code === 'invalid_assignments') return '请至少为一位运营人员填写任务数量';
  if (code === 'invalid_pids') return '请输入 1 到 500 个有效 PID';
  if (code === 'duplicate_operator') return '同一位运营人员不能重复创建';
  if (code === 'invalid_feedback') return '反馈内容不能超过 2000 个字符';
  if (code === 'forbidden') return '只有管理员可以修改任务安排';
  return '任务安排保存失败';
}

function parseBatchPids(value: string): string[] {
  const seen = new Set<string>();
  return value.split(/[\s,，;；]+/).map((pid) => pid.trim()).filter((pid) => {
    if (!pid) return false;
    const key = pid.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pidCheckErrorMessage(code: string | undefined): string {
  if (code === 'invalid_pid') return '请输入有效的纯数字 PID';
  if (code === 'invalid_source') return '请选择 TAP 或 CAP';
  if (code === 'pid_check_timeout') return '8003 查询超时，请稍后重试';
  if (code?.startsWith('pid_check_upstream_')) return '8003 挂车查询暂时不可用，请稍后重试';
  if (code === 'pid_check_incomplete_response' || code === 'pid_check_invalid_response') return '8003 未返回完整查询结果，请重试';
  return 'PID 查询失败，请检查 8003 服务后重试';
}

function ProductThumbnail({ url, name }: { url?: string | null; name?: string | null }) {
  return <span className="assignment-product-thumbnail" aria-hidden="true">
    <ImageIcon size={16} />
    {url && <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
    {name && <span className="sr-only">{name}</span>}
  </span>;
}

function formatStock(value: number | string | null | undefined): string {
  if (typeof value === 'number') return value.toLocaleString('zh-CN');
  return typeof value === 'string' && value.trim() ? value : '—';
}

function formatAssignmentTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function CrawlStatusBadge({ status, error }: { status?: TaskAssignmentProgress['crawlStatus']; error?: string }) {
  if (!status) return <span className="assignment-crawl-badge unchecked">待检查</span>;
  if (status === 'completed') return <span className="assignment-crawl-badge completed">已爬图</span>;
  if (status === 'failed') return <span className="assignment-crawl-badge failed" title={error || '爬图提交失败'}>爬图失败</span>;
  return <span className="assignment-crawl-badge running">爬图中</span>;
}

export function TaskAssignmentPanel({ user, initialAssignments }: { user: AuthUser; initialAssignments: TaskAssignment[] }) {
  const operators = getWorkspaceOperators();
  const batchOperators = operators.filter((operator) => BATCH_OPERATOR_NAMES.has(operator.name));
  const [assignments, setAssignments] = useState<AssignmentRow[]>(() => initialAssignments.map((item) => ({ ...item })));
  const [listOpen, setListOpen] = useState(false);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [batchDraft, setBatchDraft] = useState<BatchDraft | null>(null);
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [batchCreateMessage, setBatchCreateMessage] = useState('');
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft | null>(null);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [pidChecking, setPidChecking] = useState(false);
  const [pidCheckResult, setPidCheckResult] = useState<PidCheckData | null>(null);
  const [pidCheckError, setPidCheckError] = useState('');
  const [copiedAssignmentId, setCopiedAssignmentId] = useState('');
  const [pidSearch, setPidSearch] = useState('');
  const [expandedPids, setExpandedPids] = useState<Set<string>>(() => new Set());
  const progressRequest = useRef(0);
  const pidCheckRequest = useRef(0);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskCreateIntentHandled = useRef(false);

  const loadProgress = useCallback(async () => {
    const requestId = ++progressRequest.current;
    setProgressLoading(true);
    setProgressError('');
    try {
      const response = await fetch('/api/workspace/task-assignments?includeProgress=1', { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as ProgressApiPayload | null;
      if (!response.ok || !payload?.success || !Array.isArray(payload.data)) throw new Error(payload?.error ?? 'progress_load_failed');
      if (requestId === progressRequest.current) setAssignments(payload.data);
    } catch {
      if (requestId === progressRequest.current) setProgressError('待完成数量加载失败，请重试');
    } finally {
      if (requestId === progressRequest.current) setProgressLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user.role !== 'admin') void loadProgress();
  }, [loadProgress, user.role]);

  useEffect(() => {
    if (!listOpen || !assignments.some((item) => item.crawlStatus === 'pending' || item.crawlStatus === 'running')) return;
    const timer = window.setInterval(() => void loadProgress(), 5_000);
    return () => window.clearInterval(timer);
  }, [assignments, listOpen, loadProgress]);

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  async function copyText(copyId: string, text: string) {
    let copied = false;
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        textarea.remove();
      }
    }
    if (!copied) return;
    setCopiedAssignmentId(copyId);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => {
      setCopiedAssignmentId('');
      copyResetTimer.current = null;
    }, 2000);
  }

  function copyAllPids() {
    const pids = user.role === 'admin' ? visibleAdminGroups.map((group) => group.pid) : visibleOperatorGroups.map((group) => group.pid);
    if (!pids.length) return;
    void copyText('all', [...new Set(pids)].join('\n'));
  }

  function openList() {
    setListOpen(true);
    void loadProgress();
  }

  const hasPersonalProgress = assignments.every((item) => 'pendingQuantity' in item && typeof item.pendingQuantity === 'number');
  const pendingAssignments = hasPersonalProgress
    ? assignments.filter((item) => 'pendingQuantity' in item && typeof item.pendingQuantity === 'number' && item.pendingQuantity > 0)
    : [];
  const pendingPidCount = new Set(pendingAssignments.map((item) => item.pid)).size;
  const pendingVideoCount = pendingAssignments.reduce(
    (total, item) => total + ('pendingQuantity' in item && typeof item.pendingQuantity === 'number' ? item.pendingQuantity : 0),
    0,
  );
  const normalizedSearch = pidSearch.trim().toLowerCase();
  const adminGroups = [...assignments.reduce((groups, item) => {
    groups.set(item.pid, [...(groups.get(item.pid) ?? []), item]);
    return groups;
  }, new Map<string, AssignmentRow[]>())].map(([pid, rows]): AssignmentGroup => {
    const sources = [...new Set(rows.map((item) => item.source))];
    const pendingValues = rows.map((item) => item.pendingQuantity);
    const productRow = rows.find((item) => item.productPreviewUrl || item.productName || item.tapSales !== null && item.tapSales !== undefined) ?? rows[0];
    return {
      pid,
      rows,
      sourceLabel: sources.length === 1 ? sources[0].toUpperCase() : 'TAP / CAP',
      urgent: rows.some((item) => item.urgent),
      quantity: rows.reduce((sum, item) => sum + item.quantity, 0),
      pendingQuantity: pendingValues.every((value): value is number => typeof value === 'number')
        ? pendingValues.reduce((sum, value) => sum + value, 0)
        : null,
      tapSales: rows.find((item) => item.tapSales !== undefined)?.tapSales,
      localOrders: rows.find((item) => item.localOrders !== undefined)?.localOrders,
      productName: productRow?.productName,
      productPreviewUrl: productRow?.productPreviewUrl,
      productRating: productRow?.productRating,
      commissionAmount: productRow?.commissionAmount,
      productStock: productRow?.productStock,
      crawlStatus: rows.find((item) => item.crawlStatus)?.crawlStatus,
      crawlError: rows.find((item) => item.crawlError)?.crawlError,
    };
  });
  const visibleAdminGroups = normalizedSearch
    ? adminGroups.filter((group) => group.pid.toLowerCase().includes(normalizedSearch))
    : adminGroups;
  const visibleOperatorGroups = normalizedSearch
    ? adminGroups.filter((group) => group.pid.toLowerCase().includes(normalizedSearch))
    : adminGroups;
  const normalizedDraftPid = draft?.pid.trim().toLowerCase() ?? '';
  const existingPidAssignments = normalizedDraftPid
    ? assignments.filter((item) => item.id !== draft?.id && item.pid.toLowerCase() === normalizedDraftPid)
    : [];
  const existingPidQuantity = existingPidAssignments.reduce((sum, item) => sum + item.quantity, 0);
  const parsedBatchPids = batchDraft ? parseBatchPids(batchDraft.pids) : [];
  const existingBatchPidKeys = new Set(assignments.map((item) => item.pid.toLowerCase()));
  const pendingBatchPidCount = parsedBatchPids.filter((pid) => !existingBatchPidKeys.has(pid.toLowerCase())).length;
  const skippedBatchPidCount = parsedBatchPids.length - pendingBatchPidCount;

  function openCreate() {
    openCreateWithPid('');
  }

  function openCreateWithPid(pid: string) {
    setError('');
    setPidCheckResult(null);
    setPidCheckError('');
    setDraft({
      pid,
      source: 'tap',
      crawlType: 'clothing',
      urgent: false,
      operatorId: batchOperators[0]?.id ?? '',
      quantity: '1',
      quantities: Object.fromEntries(batchOperators.map((operator) => [operator.id, ''])),
    });
  }

  // 9001 can link directly to the workbench with a PID.  Only an authenticated
  // administrator may open the editable task dialog; other roles stay on the
  // normal workbench page and cannot use the link to bypass authorization.
  useEffect(() => {
    if (taskCreateIntentHandled.current || user.role !== 'admin') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('createTask') !== '1') return;
    const pid = (params.get('pid') || '').trim();
    if (!/^\d{6,30}$/.test(pid)) return;
    taskCreateIntentHandled.current = true;
    openCreateWithPid(pid);
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('createTask');
    cleanUrl.searchParams.delete('pid');
    window.history.replaceState({}, '', cleanUrl.toString());
  }, [user.role]);

  function openBatchCreate() {
    setBatchError('');
    setBatchCreateMessage('');
    setBatchDraft({
      pids: '',
      source: 'tap',
      crawlType: 'clothing',
      urgent: false,
      quantities: Object.fromEntries(batchOperators.map((operator) => [operator.id, ''])),
    });
  }

  function openEdit(item: TaskAssignment) {
    setError('');
    setPidCheckResult(null);
    setPidCheckError('');
    setDraft({ id: item.id, pid: item.pid, source: item.source, crawlType: 'clothing', urgent: item.urgent, operatorId: item.operatorId, quantity: String(item.quantity), quantities: {} });
  }

  function updateDraftPid(pid: string) {
    pidCheckRequest.current += 1;
    setPidChecking(false);
    setPidCheckResult(null);
    setPidCheckError('');
    setDraft((current) => current ? { ...current, pid } : current);
  }

  function updateDraftSource(source: 'tap' | 'cap') {
    pidCheckRequest.current += 1;
    setPidChecking(false);
    setPidCheckResult(null);
    setPidCheckError('');
    setDraft((current) => current ? { ...current, source } : current);
  }

  async function checkPid() {
    if (!draft || pidChecking) return;
    const pid = draft.pid.trim();
    if (!/^\d{6,30}$/.test(pid)) {
      setPidCheckResult(null);
      setPidCheckError('请输入有效的纯数字 PID');
      return;
    }
    const source = draft.source;
    const requestId = ++pidCheckRequest.current;
    setPidChecking(true);
    setPidCheckResult(null);
    setPidCheckError('');
    try {
      const response = await fetch('/api/workspace/task-assignments/check-pid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid, source }),
      });
      const payload = await response.json().catch(() => null) as PidCheckApiPayload | null;
      if (requestId !== pidCheckRequest.current) return;
      if (!response.ok || !payload?.success || !payload.data) {
        setPidCheckError(pidCheckErrorMessage(payload?.error));
        return;
      }
      setPidCheckResult(payload.data);
    } catch {
      if (requestId === pidCheckRequest.current) setPidCheckError('PID 查询失败，请检查网络后重试');
    } finally {
      if (requestId === pidCheckRequest.current) setPidChecking(false);
    }
  }

  function togglePid(pid: string) {
    setExpandedPids((current) => {
      const next = new Set(current);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError('');
    try {
      const batch = draft.id ? [] : batchOperators.flatMap((operator) => {
        const quantity = Number(draft.quantities[operator.id]);
        return Number.isInteger(quantity) && quantity > 0 ? [{ operatorId: operator.id, quantity }] : [];
      });
      if (!draft.id && !batch.length) {
        setError('请至少为一位运营人员填写任务数量');
        return;
      }
      const response = await fetch(draft.id ? `/api/workspace/task-assignments/${encodeURIComponent(draft.id)}` : '/api/workspace/task-assignments', {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft.id
          ? { pid: draft.pid, source: draft.source, urgent: draft.urgent, operatorId: draft.operatorId, quantity: Number(draft.quantity) }
          : { pid: draft.pid, source: draft.source, crawlType: draft.crawlType, urgent: draft.urgent, assignments: batch }),
      });
      const payload = await response.json().catch(() => null) as SaveApiPayload | null;
      if (!response.ok || !payload?.success || !payload.data) {
        setError(errorMessage(payload?.error));
        return;
      }
      const saved = payload.data;
      setAssignments((current) => draft.id && !Array.isArray(saved)
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [...(Array.isArray(saved) ? saved : [saved]), ...current]);
      setDraft(null);
      void loadProgress();
    } finally {
      setSaving(false);
    }
  }

  async function saveBatch() {
    if (!batchDraft || batchSaving) return;
    const pids = parseBatchPids(batchDraft.pids);
    if (!pids.length || pids.length > 500) {
      setBatchError('请输入 1 到 500 个 PID，可每行填写一个，也可用逗号或空格分隔');
      return;
    }
    const batch = batchOperators.flatMap((operator) => {
      const quantity = Number(batchDraft.quantities[operator.id]);
      return Number.isInteger(quantity) && quantity > 0 ? [{ operatorId: operator.id, quantity }] : [];
    });
    if (!batch.length) {
      setBatchError('请至少为一位运营人员填写任务数量');
      return;
    }
    setBatchSaving(true);
    setBatchError('');
    try {
      const response = await fetch('/api/workspace/task-assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pids, source: batchDraft.source, crawlType: batchDraft.crawlType, urgent: batchDraft.urgent, assignments: batch }),
      });
      const payload = await response.json().catch(() => null) as BatchSaveApiPayload | null;
      if (!response.ok || !payload?.success || !payload.data) {
        setBatchError(errorMessage(payload?.error));
        return;
      }
      setAssignments((current) => [...payload.data!.created, ...current]);
      const crawl = payload.crawl;
      const crawlText = crawl
        ? `；${crawl.completed} 个已爬图，${crawl.queued + crawl.active} 个正在提交爬图`
        : '';
      setBatchCreateMessage(`批量创建完成：新增 ${payload.data.createdPids.length} 个 PID，跳过 ${payload.data.skippedPids.length} 个已有 PID${crawlText}`);
      setBatchDraft(null);
      void loadProgress();
    } catch {
      setBatchError('批量创建失败，请检查网络后重试');
    } finally {
      setBatchSaving(false);
    }
  }

  async function remove(item: TaskAssignment) {
    if (!window.confirm(`删除 ${item.pid} · ${item.operatorName} · ${item.quantity}条？`)) return;
    const response = await fetch(`/api/workspace/task-assignments/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    if (response.ok) setAssignments((current) => current.filter((candidate) => candidate.id !== item.id));
    else window.alert('任务安排删除失败');
  }

  function openFeedback(item: TaskAssignment) {
    setFeedbackError('');
    setFeedbackDraft({ id: item.id, pid: item.pid, feedback: item.feedback ?? '' });
  }

  async function saveFeedback() {
    if (!feedbackDraft || feedbackSaving) return;
    setFeedbackSaving(true);
    setFeedbackError('');
    try {
      const response = await fetch(`/api/workspace/task-assignments/${encodeURIComponent(feedbackDraft.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback: feedbackDraft.feedback }),
      });
      const payload = await response.json().catch(() => null) as ApiPayload | null;
      if (!response.ok || !payload?.success || !payload.data) {
        setFeedbackError(errorMessage(payload?.error));
        return;
      }
      const updated = payload.data;
      setAssignments((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      setFeedbackDraft(null);
    } finally {
      setFeedbackSaving(false);
    }
  }

  async function exportAssignments() {
    if (exporting) return;
    setExporting(true);
    setProgressError('');
    try {
      const response = await fetch('/api/workspace/task-assignments?includeProgress=1', { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as ProgressApiPayload | null;
      if (!response.ok || !payload?.success || !Array.isArray(payload.data)) throw new Error(payload?.error ?? 'assignment_export_failed');
      const rows = payload.data as AssignmentRow[];
      setAssignments(rows);
      const XLSX = await import('xlsx');
      const sheet = XLSX.utils.json_to_sheet(rows.map((item) => ({
         PID: item.pid,
         属性: item.source.toUpperCase(),
         加急: item.urgent ? '是' : '否',
        商品名称: item.productName ?? '',
        预览图链接: item.productPreviewUrl ?? '',
        商品池销量: item.tapSales ?? '',
        评分: item.productRating ?? '',
        佣金额: item.commissionAmount ?? '',
        库存: item.productStock ?? '',
        本地出单量: item.localOrders ?? '',
        运营人员: item.operatorName,
        任务数量: item.quantity,
        已完成数量: item.completedQuantity ?? '',
        待完成数量: item.pendingQuantity ?? '',
        反馈: item.feedback,
        创建时间: item.createdAt,
      })));
      sheet['!cols'] = [22, 8, 8, 36, 45, 12, 9, 12, 12, 12, 12, 12, 12, 12, 28, 22].map((wch) => ({ wch }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, '任务安排');
      const day = new Date().toLocaleDateString('sv-SE');
      XLSX.writeFile(workbook, `任务安排_${user.role === 'admin' ? '全部运营' : user.displayName}_${day}.xlsx`, { compression: true });
    } catch {
      setProgressError('任务安排导出失败，请重试');
    } finally {
      setExporting(false);
    }
  }

  return <>
    <button className="workspace-assignment-trigger" type="button" aria-haspopup="dialog" aria-expanded={listOpen} onClick={openList}>
      <span className="workspace-assignment-trigger-icon"><ClipboardList size={21} /></span>
      {user.role === 'admin'
        ? <><span className="workspace-assignment-trigger-copy"><strong>任务安排</strong><small>{assignments.length ? `${assignments.length} 项任务` : '暂无任务'}</small></span><span className="workspace-assignment-trigger-count">{assignments.length}</span></>
        : <><span className="workspace-assignment-trigger-copy"><strong>任务 PID · {hasPersonalProgress ? pendingPidCount : '—'} 条</strong><small>待完成视频 · {hasPersonalProgress ? pendingVideoCount : '—'} 条</small></span><span className="workspace-assignment-trigger-count">{hasPersonalProgress ? pendingVideoCount : '…'}</span></>}
      <ArrowRight size={18} aria-hidden="true" />
    </button>

    {listOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setListOpen(false); }}>
      <section className="modal-card assignment-list-modal" role="dialog" aria-modal="true" aria-labelledby="assignment-list-title">
        <div className="panel-header assignment-list-header">
          <div><h2 id="assignment-list-title" className="panel-title">任务安排</h2><span className="panel-meta">{normalizedSearch ? `找到 ${user.role === 'admin' ? visibleAdminGroups.length : visibleOperatorGroups.length} / ${adminGroups.length} 个 PID` : `共 ${adminGroups.length} 个 PID`}</span></div>
          <div className="assignment-list-header-actions">
            <div className="assignment-pid-search"><Search size={15} aria-hidden="true" /><input value={pidSearch} onChange={(event) => setPidSearch(event.target.value)} placeholder="搜索 PID" aria-label="搜索任务 PID" />{pidSearch && <button type="button" aria-label="清空 PID 搜索" title="清空搜索" onClick={() => setPidSearch('')}><X size={14} /></button>}</div>
            <button className="ghost-button assignment-export-button" type="button" disabled={exporting || !assignments.length} onClick={() => void exportAssignments()}>{exporting ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{exporting ? '导出中' : '导出任务表'}</button>
            <button className={`ghost-button assignment-copy-all${copiedAssignmentId === 'all' ? ' copied' : ''}`} type="button" disabled={user.role === 'admin' ? !visibleAdminGroups.length : !visibleOperatorGroups.length} onClick={copyAllPids}>{copiedAssignmentId === 'all' ? <Check size={15} /> : <Copy size={15} />}{copiedAssignmentId === 'all' ? '已复制全部' : '一键复制全部 PID'}</button>
            {user.role === 'admin' && <button className="ghost-button" type="button" onClick={openBatchCreate}><ListPlus size={15} />批量创建</button>}
            {user.role === 'admin' && <button className="primary-button" type="button" onClick={openCreate}><Plus size={15} />新增任务</button>}
            <button className="icon-button" type="button" aria-label="关闭任务安排" onClick={() => setListOpen(false)}><X size={17} /></button>
          </div>
        </div>
        <div className="assignment-list-body">
          {(progressLoading || progressError) && <div className={`assignment-list-progress-status${progressError ? ' error' : ''}`} role="status">{progressError || '正在统计待完成数量...'}</div>}
          {batchCreateMessage && <div className="assignment-list-progress-status success" role="status">{batchCreateMessage}</div>}
          {(user.role === 'admin' ? visibleAdminGroups.length : visibleOperatorGroups.length) ? <>
            {user.role === 'admin' ? <>
              <div className="assignment-list-table">
              <div className="assignment-list-columns admin-summary" aria-hidden="true"><span>商品</span><span>属性</span><span>销量</span><span>评分</span><span>佣金额</span><span>库存</span><span>本地出单</span><span>任务数量</span><span>待完成</span><span>运营明细</span></div>
              <div className="assignment-list-rows">
                {visibleAdminGroups.map((group) => {
                  const expanded = expandedPids.has(group.pid);
                  const operatorCount = new Set(group.rows.map((item) => item.operatorId)).size;
                  return <div className="assignment-admin-group" key={group.pid}>
                    <div className="assignment-list-row admin-summary">
                      <button className="assignment-group-toggle" type="button" aria-expanded={expanded} title={group.crawlError || group.productName || group.pid} onClick={() => togglePid(group.pid)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<ProductThumbnail url={group.productPreviewUrl} name={group.productName} /><span className="assignment-product-identity"><span className="workspace-assignment-pid">{group.pid}</span>{group.urgent && <span className="assignment-urgent-badge"><Zap size={11} fill="currentColor" aria-hidden="true" />加急</span>}<CrawlStatusBadge status={group.crawlStatus} error={group.crawlError} /></span></button>
                      <strong className="assignment-source-badge">{group.sourceLabel}</strong>
                      <strong className="assignment-list-metric">{typeof group.tapSales === 'number' ? group.tapSales.toLocaleString('zh-CN') : progressLoading ? '查询中' : '—'}</strong>
                      <strong className="assignment-list-metric">{typeof group.productRating === 'number' ? group.productRating.toFixed(1) : progressLoading ? '查询中' : '—'}</strong>
                      <strong className="assignment-list-commission">{group.commissionAmount || (progressLoading ? '查询中' : '—')}</strong>
                      <strong className="assignment-list-metric">{progressLoading && group.productStock === undefined ? '查询中' : formatStock(group.productStock)}</strong>
                      <strong className="assignment-list-metric">{typeof group.localOrders === 'number' ? group.localOrders.toLocaleString('zh-CN') : progressLoading ? '查询中' : '—'}</strong>
                      <strong>{group.quantity} 条</strong>
                      <strong className="assignment-list-pending">{typeof group.pendingQuantity === 'number' ? `${group.pendingQuantity} 条` : progressLoading ? '统计中' : '—'}</strong>
                      <button className="assignment-drilldown-button" type="button" onClick={() => togglePid(group.pid)}>{operatorCount} 人 · {group.rows.length} 项</button>
                    </div>
                    {expanded && <div className="assignment-drilldown">
                      <div className="assignment-drilldown-columns" aria-hidden="true"><span>运营人员</span><span>属性</span><span>任务数量</span><span>待完成数量</span><span>反馈</span><span>操作</span></div>
                      {group.rows.map((item) => <div className="assignment-drilldown-row" key={item.id}>
                        <span className="assignment-list-operator">{item.operatorName}{item.urgent && <span className="assignment-urgent-badge"><Zap size={11} fill="currentColor" aria-hidden="true" />加急</span>}</span>
                        <strong className="assignment-source-badge">{item.source.toUpperCase()}</strong>
                        <strong>{item.quantity} 条</strong>
                        <strong className="assignment-list-pending">{typeof item.pendingQuantity === 'number' ? `${item.pendingQuantity} 条` : progressLoading ? '统计中' : '—'}</strong>
                        <button className={`assignment-feedback-button${item.feedback ? ' has-feedback' : ''}`} type="button" title={item.feedback || '填写反馈'} onClick={() => openFeedback(item)}><MessageSquareText size={14} aria-hidden="true" /><span>{item.feedback || '填写反馈'}</span></button>
                        <span className="workspace-assignment-actions"><button type="button" title="编辑任务安排" aria-label={`编辑 ${item.pid} ${item.operatorName}`} onClick={() => openEdit(item)}><Pencil size={15} /></button><button type="button" title="删除任务安排" aria-label={`删除 ${item.pid} ${item.operatorName}`} onClick={() => void remove(item)}><Trash2 size={15} /></button></span>
                      </div>)}
                    </div>}
                  </div>;
                })}
              </div>
              </div>
            </> : <>
            <div className="assignment-list-table">
            <div className="assignment-list-columns operator-view" aria-hidden="true"><span>商品</span><span>属性</span><span>销量</span><span>评分</span><span>佣金额</span><span>库存</span><span>本地出单</span><span>任务数量</span><span>待完成</span><span>安排明细</span></div>
            <div className="assignment-list-rows">
              {visibleOperatorGroups.map((group) => {
                const expanded = expandedPids.has(group.pid);
                return <div className="assignment-admin-group" key={group.pid}>
                  <div className="assignment-list-row operator-view">
                    <button className={`assignment-pid-copy${copiedAssignmentId === group.pid ? ' copied' : ''}`} type="button" title={copiedAssignmentId === group.pid ? '已复制 PID' : `${group.productName || group.pid} · 点击复制 PID`} aria-label={copiedAssignmentId === group.pid ? `已复制 PID ${group.pid}` : `复制 PID ${group.pid}`} onClick={() => void copyText(group.pid, group.pid)}><ProductThumbnail url={group.productPreviewUrl} name={group.productName} /><span className="assignment-product-identity"><span className="workspace-assignment-pid">{group.pid}</span>{group.urgent && <span className="assignment-urgent-badge"><Zap size={11} fill="currentColor" aria-hidden="true" />加急</span>}<CrawlStatusBadge status={group.crawlStatus} error={group.crawlError} /></span>{copiedAssignmentId === group.pid ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>
                    <strong className="assignment-source-badge">{group.sourceLabel}</strong>
                    <strong className="assignment-list-metric">{typeof group.tapSales === 'number' ? group.tapSales.toLocaleString('zh-CN') : progressLoading ? '查询中' : '—'}</strong>
                    <strong className="assignment-list-metric">{typeof group.productRating === 'number' ? group.productRating.toFixed(1) : progressLoading ? '查询中' : '—'}</strong>
                    <strong className="assignment-list-commission">{group.commissionAmount || (progressLoading ? '查询中' : '—')}</strong>
                    <strong className="assignment-list-metric">{progressLoading && group.productStock === undefined ? '查询中' : formatStock(group.productStock)}</strong>
                    <strong className="assignment-list-metric">{typeof group.localOrders === 'number' ? group.localOrders.toLocaleString('zh-CN') : progressLoading ? '查询中' : '—'}</strong>
                    <strong>{group.quantity} 条</strong>
                    <strong className="assignment-list-pending">{typeof group.pendingQuantity === 'number' ? `${group.pendingQuantity} 条` : progressLoading ? '统计中' : '—'}</strong>
                    <button className="assignment-drilldown-button" type="button" aria-expanded={expanded} onClick={() => togglePid(group.pid)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{group.rows.length} 项</button>
                  </div>
                  {expanded && <div className="assignment-drilldown operator-detail">
                    <div className="assignment-drilldown-columns" aria-hidden="true"><span>创建时间</span><span>属性</span><span>任务数量</span><span>已完成</span><span>待完成</span><span>反馈</span></div>
                    {group.rows.map((item) => <div className="assignment-drilldown-row" key={item.id}>
                      <span className="assignment-list-operator">{formatAssignmentTime(item.createdAt)}{item.urgent && <span className="assignment-urgent-badge"><Zap size={11} fill="currentColor" aria-hidden="true" />加急</span>}</span>
                      <strong className="assignment-source-badge">{item.source.toUpperCase()}</strong>
                      <strong>{item.quantity} 条</strong>
                      <strong>{typeof item.completedQuantity === 'number' ? `${item.completedQuantity} 条` : '—'}</strong>
                      <strong className="assignment-list-pending">{typeof item.pendingQuantity === 'number' ? `${item.pendingQuantity} 条` : '—'}</strong>
                      <button className={`assignment-feedback-button${item.feedback ? ' has-feedback' : ''}`} type="button" title={item.feedback || '填写反馈'} onClick={() => openFeedback(item)}><MessageSquareText size={14} aria-hidden="true" /><span>{item.feedback || '填写反馈'}</span></button>
                    </div>)}
                  </div>}
                </div>;
              })}
            </div>
            </div>
            </>}
          </> : <div className="assignment-list-empty"><ClipboardList size={28} /><strong>{normalizedSearch ? '没有匹配的 PID' : '暂无任务安排'}</strong>{user.role === 'admin' && !normalizedSearch && <button className="primary-button" type="button" onClick={openCreate}><Plus size={15} />新增任务</button>}</div>}
        </div>
      </section>
    </div>}

    {draft && <div className="modal-backdrop" role="presentation"><section className="modal-card assignment-editor-modal" role="dialog" aria-modal="true" aria-labelledby="assignment-editor-title">
      <div className="panel-header"><div><h2 id="assignment-editor-title" className="panel-title">{draft.id ? '编辑任务安排' : '新增任务安排'}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setDraft(null)}><X size={15} /></button></div>
      <form className="account-editor-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>PID<div className="assignment-pid-check-row"><input className="select" autoFocus value={draft.pid} maxLength={120} onChange={(event) => updateDraftPid(event.target.value)} /><button className="ghost-button assignment-pid-check-button" type="button" disabled={pidChecking || !/^\d{6,30}$/.test(draft.pid.trim())} onClick={() => void checkPid()}>{pidChecking ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}{pidChecking ? '查询中' : '查询'}</button></div>{normalizedDraftPid && <span className={`assignment-existing-quantity${existingPidAssignments.length ? ' matched' : ''}`}>{existingPidAssignments.length ? `${draft.id ? '其他安排' : '已有安排'} ${existingPidQuantity} 条，共 ${existingPidAssignments.length} 项` : '该 PID 暂无已有安排'}</span>}{pidCheckError && <span className="assignment-pid-check-result error" role="alert">{pidCheckError}</span>}{pidCheckResult && <span className={`assignment-pid-check-result ${pidCheckResult.canMount ? 'success' : 'failure'}`} role="status"><strong>{pidCheckResult.canMount ? '可挂车' : '不可挂车'}</strong><span>{pidCheckResult.reason}</span>{pidCheckResult.commissionAmount && <span className="assignment-pid-commission">佣金额 {pidCheckResult.commissionAmount}{typeof pidCheckResult.commissionRate === 'number' ? `（${pidCheckResult.commissionRate}%）` : ''}</span>}{pidCheckResult.price && <span>售价 {pidCheckResult.price}{pidCheckResult.salesText ? ` · ${pidCheckResult.salesText}` : ''}</span>}{pidCheckResult.title && <small title={pidCheckResult.title}>{pidCheckResult.title}</small>}</span>}</label>
        <fieldset className="assignment-source-field"><legend>任务属性</legend><div className="assignment-source-options"><button type="button" className={draft.source === 'tap' ? 'active' : ''} aria-pressed={draft.source === 'tap'} onClick={() => updateDraftSource('tap')}>TAP</button><button type="button" className={draft.source === 'cap' ? 'active' : ''} aria-pressed={draft.source === 'cap'} onClick={() => updateDraftSource('cap')}>CAP</button></div></fieldset>
        {!draft.id && <fieldset className="assignment-source-field"><legend>8765 爬图类型</legend><div className="assignment-source-options"><button type="button" className={draft.crawlType === 'clothing' ? 'active' : ''} aria-pressed={draft.crawlType === 'clothing'} onClick={() => setDraft((current) => current ? { ...current, crawlType: 'clothing' } : current)}>服装</button><button type="button" className={draft.crawlType === 'non_clothing' ? 'active' : ''} aria-pressed={draft.crawlType === 'non_clothing'} onClick={() => setDraft((current) => current ? { ...current, crawlType: 'non_clothing' } : current)}>非服</button></div></fieldset>}
        <button className={`assignment-urgent-toggle${draft.urgent ? ' active' : ''}`} type="button" aria-pressed={draft.urgent} onClick={() => setDraft((current) => current ? { ...current, urgent: !current.urgent } : current)}><Zap size={16} fill={draft.urgent ? 'currentColor' : 'none'} aria-hidden="true" /><span><strong>加急品</strong><small>{draft.urgent ? '已标记，运营人员会看到加急提示' : '点击标记为需要优先处理的任务'}</small></span><span className="assignment-urgent-toggle-state">{draft.urgent ? '已加急' : '普通'}</span></button>
        {draft.id ? <>
          <label>运营人员<select className="select" value={draft.operatorId} onChange={(event) => setDraft((current) => current ? { ...current, operatorId: event.target.value } : current)}>{operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label>
          <label>任务数量<input className="select" type="number" min={1} max={10000} step={1} value={draft.quantity} onChange={(event) => setDraft((current) => current ? { ...current, quantity: event.target.value } : current)} /></label>
        </> : <fieldset className="assignment-batch-field"><legend>运营人员任务数量</legend><div className="assignment-batch-grid">{batchOperators.map((operator) => <label key={operator.id}><span>{operator.name}</span><input className="select" type="number" min={0} max={10000} step={1} placeholder="0" value={draft.quantities[operator.id] ?? ''} onChange={(event) => setDraft((current) => current ? { ...current, quantities: { ...current.quantities, [operator.id]: event.target.value } } : current)} /></label>)}</div></fieldset>}
        {error && <div className="assignment-editor-error" role="alert">{error}</div>}
        <div className="modal-actions assignment-editor-actions"><button className="ghost-button" type="button" onClick={() => setDraft(null)}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving ? '保存中' : '保存'}</button></div>
      </form>
    </section></div>}

    {batchDraft && <div className="modal-backdrop" role="presentation"><section className="modal-card assignment-editor-modal assignment-batch-create-modal" role="dialog" aria-modal="true" aria-labelledby="assignment-batch-editor-title">
      <div className="panel-header"><div><h2 id="assignment-batch-editor-title" className="panel-title">批量创建任务安排</h2><span className="panel-meta">已有 PID 会整项跳过，不修改原安排</span></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setBatchDraft(null)}><X size={15} /></button></div>
      <form className="account-editor-form" onSubmit={(event) => { event.preventDefault(); void saveBatch(); }}>
        <label>PID 列表<textarea className="select assignment-batch-pids" autoFocus rows={9} maxLength={65_000} placeholder={'每行一个 PID\n也支持用逗号或空格分隔'} value={batchDraft.pids} onChange={(event) => { setBatchError(''); setBatchDraft((current) => current ? { ...current, pids: event.target.value } : current); }} /></label>
        <span className="assignment-batch-summary">已识别 {parsedBatchPids.length} 个 PID · 可新增 {pendingBatchPidCount} 个 · 将跳过已有 {skippedBatchPidCount} 个</span>
        <fieldset className="assignment-source-field"><legend>任务属性</legend><div className="assignment-source-options"><button type="button" className={batchDraft.source === 'tap' ? 'active' : ''} aria-pressed={batchDraft.source === 'tap'} onClick={() => setBatchDraft((current) => current ? { ...current, source: 'tap' } : current)}>TAP</button><button type="button" className={batchDraft.source === 'cap' ? 'active' : ''} aria-pressed={batchDraft.source === 'cap'} onClick={() => setBatchDraft((current) => current ? { ...current, source: 'cap' } : current)}>CAP</button></div></fieldset>
        <fieldset className="assignment-source-field"><legend>8765 爬图类型</legend><div className="assignment-source-options"><button type="button" className={batchDraft.crawlType === 'clothing' ? 'active' : ''} aria-pressed={batchDraft.crawlType === 'clothing'} onClick={() => setBatchDraft((current) => current ? { ...current, crawlType: 'clothing' } : current)}>服装</button><button type="button" className={batchDraft.crawlType === 'non_clothing' ? 'active' : ''} aria-pressed={batchDraft.crawlType === 'non_clothing'} onClick={() => setBatchDraft((current) => current ? { ...current, crawlType: 'non_clothing' } : current)}>非服</button></div></fieldset>
        <button className={`assignment-urgent-toggle${batchDraft.urgent ? ' active' : ''}`} type="button" aria-pressed={batchDraft.urgent} onClick={() => setBatchDraft((current) => current ? { ...current, urgent: !current.urgent } : current)}><Zap size={16} fill={batchDraft.urgent ? 'currentColor' : 'none'} aria-hidden="true" /><span><strong>加急品</strong><small>{batchDraft.urgent ? '本批新任务都会显示加急标志' : '点击将本批新任务标记为加急'}</small></span><span className="assignment-urgent-toggle-state">{batchDraft.urgent ? '已加急' : '普通'}</span></button>
        <fieldset className="assignment-batch-field"><legend>每个 PID 的运营人员任务数量</legend><div className="assignment-batch-grid">{batchOperators.map((operator) => <label key={operator.id}><span>{operator.name}</span><input className="select" type="number" min={0} max={10000} step={1} placeholder="0" value={batchDraft.quantities[operator.id] ?? ''} onChange={(event) => setBatchDraft((current) => current ? { ...current, quantities: { ...current.quantities, [operator.id]: event.target.value } } : current)} /></label>)}</div></fieldset>
        {batchError && <div className="assignment-editor-error" role="alert">{batchError}</div>}
        <div className="modal-actions assignment-editor-actions"><button className="ghost-button" type="button" onClick={() => setBatchDraft(null)}>取消</button><button className="primary-button" type="submit" disabled={batchSaving || !parsedBatchPids.length}>{batchSaving ? '创建中' : `批量创建 ${pendingBatchPidCount} 个 PID`}</button></div>
      </form>
    </section></div>}

    {feedbackDraft && <div className="modal-backdrop" role="presentation"><section className="modal-card assignment-editor-modal" role="dialog" aria-modal="true" aria-labelledby="assignment-feedback-title">
      <div className="panel-header"><div><h2 id="assignment-feedback-title" className="panel-title">任务反馈</h2><span className="panel-meta">PID {feedbackDraft.pid}</span></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setFeedbackDraft(null)}><X size={15} /></button></div>
      <form className="account-editor-form" onSubmit={(event) => { event.preventDefault(); void saveFeedback(); }}>
        <label>反馈<textarea className="select assignment-feedback-input" autoFocus rows={7} maxLength={2000} placeholder="输入这条 PID 任务的具体反馈" value={feedbackDraft.feedback} onChange={(event) => setFeedbackDraft((current) => current ? { ...current, feedback: event.target.value } : current)} /></label>
        {feedbackError && <div className="assignment-editor-error" role="alert">{feedbackError}</div>}
        <div className="modal-actions assignment-editor-actions"><button className="ghost-button" type="button" onClick={() => setFeedbackDraft(null)}>取消</button><button className="primary-button" type="submit" disabled={feedbackSaving}>{feedbackSaving ? '保存中' : '保存反馈'}</button></div>
      </form>
    </section></div>}
  </>;
}
