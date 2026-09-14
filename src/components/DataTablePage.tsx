import Link from 'next/link';
import { ArrowUpRight, Image as ImageIcon, Users } from 'lucide-react';
import { formatCompact } from '@/lib/earningsTrend';
import { WorkspaceClient } from './WorkspaceClient';
import type { AuthUser } from '@/lib/auth/policy';
import { listStoredAccounts } from '@/lib/workspace/accountStore';
import { withLiveAccountStatsList } from '@/lib/workspace/accountStats';
import { getDashboardSnapshot } from '@/lib/workspace/dashboardStats';
import { getWorkspaceOperatorForUser } from '@/lib/workspace/data';

export function DownstreamPage() {
  const { totals, videos } = getDashboardSnapshot();
  return <>
    <div className="page-heading">
      <div><div className="eyebrow">Downstream / observatory</div><h1>下游看板</h1><p className="subtitle">发布后的播放、点击和交易指标只来自已授权的下游同步。</p></div>
      <div className="toolbar"><span className="service-pill" style={{ display: 'flex' }}><span className="dot" /> 9001 daily-trend</span><Link href="/workspace" className="ghost-button" style={{ textDecoration: 'none' }}>进入工作台 <ArrowUpRight size={14} /></Link></div>
    </div>
    <div className="section-grid kpi-grid">
      <Metric label="今日发布" value={String(totals.published)} hint="来自 9001 的真实发布数据" />
      <Metric label="累计播放" value={formatCompact(totals.views)} hint="来自 9001 的真实播放数据" />
      <Metric label="成交订单" value={formatCompact(totals.orders)} hint="来自 9001 的真实订单数据" />
      <Metric label="退款金额" value={`¥${formatCompact(totals.refunds)}`} hint="来自 9001 的真实退款数据" />
    </div>
    <section className="panel table-panel">
      <div className="panel-header"><div><h2 className="panel-title">视频明细</h2><div className="panel-meta">可按 PID、账号和发布时间筛选</div></div><div className="toolbar"><input className="select" placeholder="搜索视频 / PID" aria-label="搜索视频或 PID" /><select className="select" aria-label="选择排序"><option>成交额最高</option><option>播放最高</option><option>最新发布</option></select></div></div>
      <div className="table-scroll"><table><thead><tr><th>视频 / PID</th><th>账号</th><th>指标</th><th>订单</th><th>成交额</th><th>状态</th></tr></thead><tbody>{videos.length ? videos.map((video) => <tr key={video.id}><td><div className="video-cell"><div className="cover" style={{ background: video.cover }} /><div><strong>{video.title}</strong><div style={{ color: '#9aa3b2', marginTop: 4, fontFamily: 'Fira Code' }}>PID {video.pid}</div></div></div></td><td>{video.account}</td><td><div>{formatCompact(video.views)} 播放</div><div style={{ color: '#9aa3b2', marginTop: 3 }}>{formatCompact(video.clicks)} 点击 · {formatCompact(video.likes)} 赞</div></td><td><strong>{video.orders}</strong></td><td><strong>¥{formatCompact(video.gmv)}</strong></td><td><span className="status"><span className="dot" /> 已归因</span></td></tr>) : <tr><td colSpan={6}><div className="empty-state">暂无已同步的视频数据</div></td></tr>}</tbody></table></div>
    </section>
  </>;
}

export function AccountsPage() {
  const snapshot = getDashboardSnapshot();
  const accounts = snapshot.accounts;
  const totalAccounts = accounts.length;
  const healthyAccounts = accounts.filter((account) => account.status === 'healthy').length;
  const attentionAccounts = accounts.filter((account) => account.status === 'attention').length;
  return <>
    <div className="page-heading"><div><div className="eyebrow">Assets / accounts</div><h1>账号资产</h1><p className="subtitle">当前工作区的账号清单与可核验的经营指标。</p></div><div className="toolbar"><button className="ghost-button" type="button" disabled>导出账号表</button></div></div>
    <div className="section-grid kpi-grid">
      <Metric label="账号总数" value={String(totalAccounts)} hint="来自工作区账号存储" />
      <Metric label="计划已填写" value={String(healthyAccounts)} hint="账号运营计划状态" />
      <Metric label="今日活跃" value={String(snapshot.production.activeAccountsToday)} hint="今日创建过生产任务的账号" />
      <Metric label="待关注" value={String(attentionAccounts)} hint="运营计划尚未填写" />
    </div>
    <section className="panel table-panel"><div className="panel-header"><div><h2 className="panel-title">账号表现</h2><div className="panel-meta">发布、播放和交易指标仅来自已授权的下游数据源</div></div></div><div className="table-scroll"><table><thead><tr><th>账号</th><th>负责人 / 类目</th><th>状态</th><th>发布</th><th>播放</th><th>成交额</th><th>转化</th></tr></thead><tbody>{accounts.length ? accounts.map((account) => <tr key={account.id}><td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="notice-icon"><Users size={14} /></div><strong>{account.name}</strong></div></td><td>{account.ownerName} · {account.category === 'featured' ? '精选账号' : '混剪账号'}</td><td><span className={`status ${account.status === 'attention' ? 'attention' : ''}`}><span className="dot" />{account.status === 'healthy' ? '计划已填写' : '待填写计划'}</span></td><td>{account.published}</td><td>{formatCompact(account.views)}</td><td><strong>¥{formatCompact(account.gmv)}</strong></td><td>{account.conversion.toFixed(1)}%</td></tr>) : <tr><td colSpan={7}><div className="empty-state">暂无账号数据</div></td></tr>}</tbody></table></div></section>
  </>;
}

export function WorkspacePage({ user }: { user: AuthUser }) {
  const ownerId = user.role === 'admin' || user.role === 'operator' ? undefined : getWorkspaceOperatorForUser(user.username, user.displayName).id;
  const storedAccounts = listStoredAccounts(ownerId ? { ownerId } : {});
  // Keep the workspace route itself cheap. Task counters are derived from the
  // large provider task store, so the client loads them after the page shell
  // is interactive instead of blocking the RSC navigation request.
  return <WorkspaceClient user={user} initialAccounts={withLiveAccountStatsList(storedAccounts)} initialTaskCounters={{}} />;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <article className="kpi"><div className="kpi-label"><span>{label}</span></div><div className="kpi-value">{value}</div><div className="kpi-foot">{hint}</div></article>;
}

export function AssetIcon() { return <ImageIcon size={14} aria-hidden="true" />; }
