'use client';

import { ArrowUpRight, Eye, MousePointer2, PackageCheck, PlaySquare, ShoppingCart, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { DashboardSnapshot } from '@/lib/workspace/dashboardStats';
import { formatCompact } from '@/lib/earningsTrend';
import { EarningsTrendBoard } from './EarningsTrendBoard';

const emptySnapshot: DashboardSnapshot = {
  accounts: [],
  totals: { published: 0, views: 0, clicks: 0, orders: 0, gmv: 0, refunds: 0 },
  production: { total: 0, queued: 0, running: 0, completed: 0, failed: 0, paused: 0, successfulOutputs: 0, inventorySavedToday: 0, completedNotInInventory: 0, activeAccountsToday: 0 },
  videos: [],
  products: [],
};

export function DashboardPage() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/dashboard', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: DashboardSnapshot }) => {
        if (!cancelled && payload.success && payload.data) setSnapshot(payload.data);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const { totals, accounts, production } = snapshot;
  const rankedAccounts = useMemo(
    () => accounts.filter((account) => account.published > 0 || account.views > 0 || account.gmv > 0 || account.conversion > 0),
    [accounts],
  );

  return <>
    <div className="page-heading">
      <div>
        <div className="eyebrow">Control room / overview</div>
        <h1>今日生产与经营总览</h1>
        <p className="subtitle">统计来自当前工作区和已授权的下游同步数据。</p>
      </div>
      <div className="toolbar">
        <span className="tag">实时读取 D 盘数据</span>
        <Link href="/downstream" className="ghost-button" style={{ textDecoration: 'none' }} prefetch={false}>
          查看下游看板 <ArrowUpRight size={14} />
        </Link>
      </div>
    </div>

    <div className="section-grid kpi-grid">
      <Kpi icon={<ShoppingCart size={17} />} label="累计成交额" value={`¥${formatCompact(totals.gmv)}`} foot="无可信同步数据时显示 0" />
      <Kpi icon={<PackageCheck size={17} />} label="订单数" value={formatCompact(totals.orders)} foot="无可信同步数据时显示 0" />
      <Kpi icon={<Eye size={17} />} label="视频播放" value={formatCompact(totals.views)} foot="无可信同步数据时显示 0" />
      <Kpi icon={<MousePointer2 size={17} />} label="整体点击率" value={`${((totals.clicks / Math.max(totals.views, 1)) * 100).toFixed(2)}%`} foot="无可信同步数据时显示 0%" />
    </div>

    <div className="section-grid content-grid">
      <EarningsTrendBoard />
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">账号表现排行</h2>
            <div className="panel-meta">仅展示有真实下游表现的账号</div>
          </div>
          <Link href="/accounts" className="panel-meta" style={{ color: '#1e40af', textDecoration: 'none' }} prefetch={false}>
            全部账号 <ArrowUpRight size={13} />
          </Link>
        </div>
        <div className="ranking">
          {rankedAccounts.length ? rankedAccounts.slice(0, 8).map((account, index) => (
            <div className="rank-row" key={account.id}>
              <div className="rank-no">{String(index + 1).padStart(2, '0')}</div>
              <div>
                <div className="rank-name">{account.name}</div>
                <div className="rank-sub">{account.ownerName} · {account.category}</div>
              </div>
              <div className="rank-value">¥{formatCompact(account.gmv)}</div>
            </div>
          )) : <div className="empty-state">暂无已同步的下游表现数据</div>}
        </div>
      </section>
    </div>

    <div className="section-grid content-grid">
      <section className="panel table-panel" style={{ marginTop: 0 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">最近发布的视频</h2>
            <div className="panel-meta">等待授权的发布数据同步</div>
          </div>
          <Link href="/downstream" className="panel-meta" style={{ color: '#1e40af', textDecoration: 'none' }} prefetch={false}>
            打开明细 <ArrowUpRight size={13} />
          </Link>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>视频</th><th>账号</th><th>发布时间</th><th>播放</th><th>订单</th><th>成交额</th></tr>
            </thead>
            <tbody>
              {snapshot.videos.length ? snapshot.videos.slice(0, 4).map((video) => (
                <tr key={video.id}>
                  <td>
                    <div className="video-cell">
                      <div className="cover" style={{ background: video.cover }} />
                      <div>
                        <strong className="video-title">{video.title}</strong>
                        <div style={{ color: '#9aa3b2', marginTop: 4, fontFamily: 'Fira Code' }}>PID {video.pid}</div>
                      </div>
                    </div>
                  </td>
                  <td>{video.account}</td>
                  <td>{video.publishedAt}</td>
                  <td>{formatCompact(video.views)}</td>
                  <td>{video.orders}</td>
                  <td><strong>¥{formatCompact(video.gmv)}</strong></td>
                </tr>
              )) : <tr><td colSpan={6}><div className="empty-state">暂无已同步的发布视频</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">同步与提醒</h2>
            <div className="panel-meta">工作区生产数据</div>
          </div>
          <Sparkles size={16} color="#1e40af" />
        </div>
        <div className="notice-list">
          <div className="notice">
            <div className="notice-icon"><PackageCheck size={13} /></div>
            <div>
              <div className="notice-title">下游发布数据</div>
              <div className="notice-text">9001 尚未提供可信的发布、播放、交易同步数据。</div>
            </div>
          </div>
          <div className="notice">
            <div className="notice-icon"><PlaySquare size={13} /></div>
            <div>
              <div className="notice-title">生产任务 {production.total} 条</div>
              <div className="notice-text">完成 {production.completed} · 失败 {production.failed} · 处理中 {production.running + production.queued}</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </>;
}

function Kpi({ icon, label, value, foot }: { icon: React.ReactNode; label: string; value: string; foot: string }) {
  return <article className="kpi"><div className="kpi-label"><span>{label}</span><span style={{ color: '#1e40af' }}>{icon}</span></div><div className="kpi-value">{value}</div><div className="kpi-foot">{foot}</div></article>;
}
