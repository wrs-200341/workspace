'use client';

import Link from 'next/link';
import { ArrowUpRight, FileText, Image as ImageIcon, Pencil, PlaySquare, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ROLE_LABELS, type AuthUser } from '@/lib/auth/policy';
import { getWorkspaceOperatorForUser, getWorkspaceOperators, type WorkspaceAccount, type WorkspaceCategory } from '@/lib/workspace/data';
import { canEditWorkspaceOwner, countWorkspaceAccounts, filterWorkspaceAccounts } from '@/lib/workspace/selection';

type OwnerTaskCounters = {
  inventorySavedToday: number;
  completedNotInInventory: number;
  running: number;
  queued: number;
  failed: number;
};
type Props = { user: AuthUser; initialAccounts: WorkspaceAccount[]; initialTaskCounters: Record<string, OwnerTaskCounters> };

export function WorkspaceClient({ user, initialAccounts, initialTaskCounters }: Props) {
  const operators = useMemo(() => {
    const recovered = getWorkspaceOperators();
    if (user.role === 'admin') return recovered;
    if (user.role === 'workspace') {
      return [getWorkspaceOperatorForUser(user.username, user.displayName)];
    }
    const own = getWorkspaceOperatorForUser(user.username, user.displayName);
    return recovered.some((operator) => operator.id === own.id) ? recovered : [...recovered, own];
  }, [user.displayName, user.role, user.username]);
  const initialOwner = user.role === 'admin'
    ? operators[0]?.id
    : getWorkspaceOperatorForUser(user.username, user.displayName).id;
  const [ownerId, setOwnerId] = useState(initialOwner);
  const [liveAccounts, setLiveAccounts] = useState<WorkspaceAccount[]>(() => initialAccounts.map((account) => ({ ...account })));
  const [category, setCategory] = useState<WorkspaceCategory>('featured');
  const [planAccountId, setPlanAccountId] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState('');
  const [accountEditor, setAccountEditor] = useState<{ id?: string; name: string; strategy: string; category: WorkspaceCategory } | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(() => new Date());
  const ownOwnerId = getWorkspaceOperatorForUser(user.username, user.displayName).id;
  // Keep the workspace role pinned to its own owner lane even when a browser
  // preserves component state during a hot refresh or restores an older
  // session snapshot. This prevents stale Chenxi/operator state from
  // resurfacing in a workbench account.
  const effectiveOwnerId = user.role === 'workspace' ? ownOwnerId : ownerId;
  const owner = operators.find((item) => item.id === effectiveOwnerId) ?? operators[0];
  const canEditSelectedOwner = canEditWorkspaceOwner(user.role, effectiveOwnerId, ownOwnerId);
  const accounts = useMemo(() => filterWorkspaceAccounts(liveAccounts, effectiveOwnerId, category), [liveAccounts, effectiveOwnerId, category]);
  const accountCountFor = (item: WorkspaceCategory) => countWorkspaceAccounts(liveAccounts, effectiveOwnerId, item);
  useEffect(() => {
    if (user.role === 'workspace' && ownerId !== ownOwnerId) setOwnerId(ownOwnerId);
  }, [ownerId, ownOwnerId, user.role]);
  const summary = initialTaskCounters[effectiveOwnerId] ?? {
    inventorySavedToday: 0,
    completedNotInInventory: 0,
    running: 0,
    queued: 0,
    failed: 0,
  };
  const selectedAccount = planAccountId ? liveAccounts.find((account) => account.id === planAccountId && account.ownerId === effectiveOwnerId) : undefined;

  useEffect(() => {
    if (canEditSelectedOwner) return;
    setPlanAccountId(null);
    setAccountEditor(null);
  }, [canEditSelectedOwner]);

  async function refreshStats() {
    try {
      // Operators keep all readable owner lanes in memory so switching the
      // selector remains instant; the visible list is filtered locally.
      const query = ownerId && user.role !== 'operator' ? `?ownerId=${encodeURIComponent(ownerId)}` : '';
      const response = await fetch(`/api/workspace/accounts${query}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: { accounts?: WorkspaceAccount[] } } | null;
      if (response.ok && payload?.success && Array.isArray(payload.data?.accounts)) {
        setLiveAccounts(payload.data.accounts.map((account) => ({ ...account })));
      }
    } finally {
      setRefreshedAt(new Date());
    }
  }
  function openPlan(accountId: string) { if (!canEditSelectedOwner) return; const account = liveAccounts.find((item) => item.id === accountId); setPlanAccountId(accountId); setPlanDraft(account?.strategy ?? ''); }
  function openAccountEditor(account?: WorkspaceAccount) { if (!canEditSelectedOwner) return; setAccountEditor(account ? { id: account.id, name: account.name, strategy: account.strategy, category: account.category } : { name: '', strategy: '', category }); }
  async function saveAccount() {
    if (!accountEditor || !canEditSelectedOwner) return;
    const body = !accountEditor.id && user.role === 'admin' ? { ...accountEditor, ownerId } : accountEditor;
    const response = await fetch(accountEditor.id ? `/api/workspace/accounts/${accountEditor.id}` : '/api/workspace/accounts', {
      method: accountEditor.id ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
    if (!response.ok || !payload?.success) {
      window.alert(payload?.error || '保存账号失败');
      return;
    }
    setAccountEditor(null);
    await refreshStats();
  }
  async function savePlan() {
    if (!selectedAccount || !canEditSelectedOwner) return;
    const response = await fetch(`/api/workspace/accounts/${selectedAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: planDraft, planStatus: 'planned' }),
    });
    if (response.ok) {
      setPlanAccountId(null);
      await refreshStats();
    }
  }

  return <>
    <div className="page-heading workspace-heading"><div><div className="eyebrow">Workspace / production control</div><h1>{owner?.name ?? '运营人员'}的{category === 'featured' ? '精选账号' : '混剪账号'}</h1><p className="subtitle">统一管理运营计划、素材资产、生产队列和视频入库。3000 负责观测与复盘，执行器保持解耦。</p></div><div className="toolbar"><span className="tag">{user.role === 'admin' ? '全局查看' : user.role === 'operator' && ownerId !== ownOwnerId ? `查看 ${owner?.name ?? '运营工作区'}` : `我的工作区 · ${ROLE_LABELS[user.role]}`}</span><button className="ghost-button" type="button" onClick={refreshStats}><RefreshCw size={14} /> 刷新计数</button></div></div>
    <div className="workspace-layout"><aside className="workspace-rail panel" aria-label="工作台筛选"><div className="rail-section"><div className="rail-title">运营人员</div><select className="select" value={ownerId} onChange={(event) => setOwnerId(event.target.value)} aria-label="选择运营人员" disabled={user.role === 'workspace'}>{operators.map((operator) => <option value={operator.id} key={operator.id}>{operator.name} · {operator.username}</option>)}</select>{user.role === 'operator' ? <div className="rail-help">可查看其他运营工作区，只有自己的工作区可以编辑</div> : user.role === 'workspace' ? <div className="rail-help">当前工作台账号只能查看指定工作区</div> : <div className="rail-help">管理员可查看并编辑所有工作区</div>}</div><div className="rail-section"><div className="rail-title">账号类型</div>{(['featured', 'remix'] as const).map((item) => <button className={`rail-filter ${category === item ? 'active' : ''}`} key={item} onClick={() => setCategory(item)} type="button"><span>{item === 'featured' ? '精选账号' : '混剪账号'}</span><span className="rail-count">{accountCountFor(item)}</span></button>)}</div><div className="rail-section counter-section"><div className="rail-title">INVENTORY COUNTER</div><div className="counter-value" aria-live="polite">{summary.inventorySavedToday}</div><div className="counter-label">今日成功入库任务</div><div className="counter-row"><span>今日未入库</span><strong className={summary.completedNotInInventory ? 'warning-text' : ''}>{summary.completedNotInInventory}</strong></div><div className="counter-row"><span>处理中</span><strong>{summary.running + summary.queued}</strong></div><div className="counter-row"><span>失败待重试</span><strong>{summary.failed}</strong></div></div><div className="rail-section rail-footer"><Link href="/workspace" className="nav-item"><ArrowUpRight size={15} /> 返回工作台</Link>{user.role === 'admin' && <Link href="/admin/accounts" className="nav-item"><Settings2 size={15} /> 账号控制</Link>}</div></aside>
      <div className={`workspace-main ${canEditSelectedOwner ? '' : 'workspace-panel-read-only'}`}>
        <section className="panel account-panel"><div className="panel-header"><div><h2 className="panel-title">账号工作区</h2><div className="panel-meta">账号卡保留运营计划、资产和生产入口，可随时编辑或新增</div></div><div className="toolbar"><span className="tag">{refreshedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span><button type="button" className="primary-button" onClick={() => openAccountEditor()}><Plus size={14} /> 添加账号</button></div></div><div className="account-grid">{accounts.map((account, index) => <article className="account-card" key={account.id}><div className="account-card-top"><span className="account-index">{String(index + 1).padStart(2, '0')}</span><span className={`status ${account.planStatus === 'draft' ? 'attention' : ''}`}><span className="dot" />{account.planStatus === 'planned' ? '计划已填写' : '待填写计划'}</span></div><div className="account-card-title-row"><h3>{account.name}</h3><button type="button" className="icon-button" onClick={() => openAccountEditor(account)} aria-label="编辑账号"><Pencil size={13} /></button></div><div className="account-owner">{account.ownerName} · <span className="tag">{account.category === 'featured' ? '精选' : '混剪'}</span></div><p>{account.strategy}</p><div className="account-stats"><span><strong>{account.promptCount}</strong> prompts</span><span><strong>{account.fileCount}</strong> 素材</span><span><strong>{account.videoCount}</strong> 视频</span></div><div className="account-actions"><Link href={`/workspace/accounts/${account.id}/assets`} className="ghost-button"><ImageIcon size={14} /> 账号资产</Link><Link href={`/workspace/accounts/${account.id}/production?mode=video`} className="primary-button"><PlaySquare size={14} /> 进入生产</Link></div><button type="button" className="plan-link" onClick={() => openPlan(account.id)}><FileText size={13} /> {account.planStatus === 'planned' ? '查看 / 编辑运营计划' : '补充运营计划'}</button></article>)}</div></section>
      </div></div>
    {selectedAccount && <div className="modal-backdrop" role="presentation"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="plan-title"><div className="panel-header"><div><h2 id="plan-title" className="panel-title">运营计划 · {selectedAccount.name}</h2><div className="panel-meta">最多 30,000 字；保存后作为生产和复盘上下文</div></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setPlanAccountId(null)}><X size={15} /></button></div><textarea className="plan-textarea" maxLength={30000} value={planDraft} onChange={(event) => setPlanDraft(event.target.value)} /><div className="modal-actions"><span className="panel-meta">{planDraft.length.toLocaleString()} / 30,000</span><button className="ghost-button" type="button" onClick={() => setPlanAccountId(null)}>取消</button><button className="primary-button" type="button" onClick={savePlan}>保存计划</button></div></section></div>}
    {accountEditor && <div className="modal-backdrop" role="presentation"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="account-editor-title"><div className="panel-header"><div><h2 id="account-editor-title" className="panel-title">{accountEditor.id ? '编辑账号' : '添加账号'}</h2><div className="panel-meta">当前页面只展示并编辑所选运营工作区内的账号</div></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setAccountEditor(null)}><X size={15} /></button></div><div className="account-editor-form"><label>账号名称<input className="select" value={accountEditor.name} onChange={(event) => setAccountEditor((current) => current ? { ...current, name: event.target.value } : current)} /></label><label>账号类型<select className="select" value={accountEditor.category} onChange={(event) => setAccountEditor((current) => current ? { ...current, category: event.target.value as WorkspaceCategory } : current)}><option value="featured">精选账号</option><option value="remix">混剪账号</option></select></label><label>运营策略<textarea className="select" rows={6} value={accountEditor.strategy} onChange={(event) => setAccountEditor((current) => current ? { ...current, strategy: event.target.value } : current)} /></label></div><div className="modal-actions"><button className="ghost-button" type="button" onClick={() => setAccountEditor(null)}>取消</button><button className="primary-button" type="button" onClick={saveAccount}>保存账号</button></div></section></div>}
  </>;
}
