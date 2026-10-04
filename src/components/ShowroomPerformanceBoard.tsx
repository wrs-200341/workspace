'use client';

import { CalendarDays, CircleDollarSign, ExternalLink, ImageIcon, RefreshCw, Search, ShoppingCart, UserRoundCheck, Video } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ShowroomPerformance, ShowroomOperatorName } from '@/lib/workspace/showroomPerformance';

type RangeKey = 'all' | 'today' | '7d' | '30d';
type ApiPayload = { success?: boolean; stale?: boolean; syncedAt?: string; data?: ShowroomPerformance };

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: '7d', label: '近 7 日' },
  { key: '30d', label: '近 30 日' },
];
const VIDEO_PAGE_SIZE = 30;

function number(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function money(value: number, currency: string): string {
  if (currency === 'MIXED') return `${number(Math.round(value))}（多币种）`;
  if (currency === 'MXN') return `MX$${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN', maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency || 'MXN'} ${value.toFixed(2)}`;
  }
}

function localTime(value: string): string {
  if (!value) return '未同步发布时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.replace('T', ' ') : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function ShowroomPerformanceBoard() {
  const [range, setRange] = useState<RangeKey>('all');
  const [data, setData] = useState<ShowroomPerformance | null>(null);
  const [selectedOwner, setSelectedOwner] = useState<'all' | ShowroomOperatorName>('all');
  const [selectedHandle, setSelectedHandle] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [syncedAt, setSyncedAt] = useState('');

  const load = useCallback(async (force = false, signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/showroom-performance?range=${range}${force ? '&refresh=1' : ''}`, { cache: 'no-store', signal });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success || !payload.data) throw new Error('load_failed');
      setData(payload.data);
      setStale(Boolean(payload.stale));
      setSyncedAt(payload.syncedAt ?? '');
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError('9001 收益数据暂时不可用，请稍后重试');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => { setPage(1); setSelectedHandle(''); }, [range, selectedOwner]);
  useEffect(() => { setPage(1); }, [query, selectedHandle]);

  const normalizedQuery = query.trim().toLowerCase();
  const accounts = useMemo(() => (data?.accounts ?? []).filter((account) => {
    if (selectedOwner !== 'all' && account.ownerName !== selectedOwner) return false;
    if (!normalizedQuery) return true;
    return `${account.workspaceAccountName} ${account.handle ?? ''} ${account.ownerName}`.toLowerCase().includes(normalizedQuery);
  }), [data, normalizedQuery, selectedOwner]);
  const videos = useMemo(() => (data?.videos ?? []).filter((video) => {
    if (selectedOwner !== 'all' && video.ownerName !== selectedOwner) return false;
    if (selectedHandle && video.creatorUsername !== selectedHandle) return false;
    if (!normalizedQuery) return true;
    return `${video.videoId} ${video.productId} ${video.productName} ${video.creatorUsername} ${video.workspaceAccountName} ${video.ownerName}`.toLowerCase().includes(normalizedQuery);
  }), [data, normalizedQuery, selectedHandle, selectedOwner]);
  const totalPages = Math.max(1, Math.ceil(videos.length / VIDEO_PAGE_SIZE));
  const visibleVideos = videos.slice((page - 1) * VIDEO_PAGE_SIZE, page * VIDEO_PAGE_SIZE);
  const scopedTotals = useMemo(() => ({
    videos: videos.length,
    orders: videos.reduce((sum, video) => sum + video.orders, 0),
    gmv: videos.reduce((sum, video) => sum + video.gmv, 0),
    matchedAccounts: new Set(videos.map((video) => video.creatorUsername)).size,
    currency: videos.length && videos.every((video) => video.currency === videos[0].currency) ? videos[0].currency : videos.length ? 'MIXED' : data?.totals.currency ?? 'MXN',
  }), [data, videos]);

  return <>
    <div className="page-heading showroom-heading">
      <div>
        <div className="eyebrow">Showroom / attributed earnings</div>
        <h1>精选账号出单放映厅</h1>
        <p className="subtitle">按运营人员和精选账号匹配 9001“我的收益”，查看每条归因视频的出单与 GMV。</p>
      </div>
      <div className="toolbar">
        <span className={`service-pill ${stale ? 'attention' : ''}`}><span className="dot" /> {stale ? '9001 缓存数据' : '9001 收益已接入'}</span>
        <button className="icon-button" type="button" title="刷新收益数据" aria-label="刷新收益数据" disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
      </div>
    </div>

    <div className="showroom-controls" aria-label="放映厅筛选">
      <div className="showroom-segments" aria-label="收益时间范围">
        {RANGE_OPTIONS.map((item) => <button key={item.key} type="button" className={range === item.key ? 'active' : ''} onClick={() => setRange(item.key)}>{item.label}</button>)}
      </div>
      <label className="showroom-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、视频 ID 或 PID" aria-label="搜索账号、视频 ID 或 PID" /></label>
      <span className="showroom-sync-time"><CalendarDays size={14} /> {syncedAt ? `同步于 ${localTime(syncedAt)}` : '等待同步'}</span>
    </div>

    {error && <div className="showroom-error" role="alert">{error}<button type="button" onClick={() => void load(true)}>重试</button></div>}

    <div className="section-grid kpi-grid showroom-kpis" aria-busy={loading}>
      <Metric icon={<Video size={17} />} label="归因视频" value={number(scopedTotals.videos)} hint="9001 收益订单关联的视频" />
      <Metric icon={<ShoppingCart size={17} />} label="出单" value={number(scopedTotals.orders)} hint="沿用 9001 我的收益口径" />
      <Metric icon={<CircleDollarSign size={17} />} label="归因 GMV" value={money(scopedTotals.gmv, scopedTotals.currency)} hint="按订单商品成交金额汇总" />
      <Metric icon={<UserRoundCheck size={17} />} label="有出单账号" value={number(scopedTotals.matchedAccounts)} hint={`当前筛选共 ${number(accounts.length)} 个精选账号`} />
    </div>

    <div className="showroom-owner-tabs" role="tablist" aria-label="运营人员">
      <button type="button" role="tab" aria-selected={selectedOwner === 'all'} className={selectedOwner === 'all' ? 'active' : ''} onClick={() => setSelectedOwner('all')}>全部 <span>{data?.totals.videos ?? 0}</span></button>
      {(data?.operators ?? []).map((operator) => <button type="button" role="tab" aria-selected={selectedOwner === operator.name} className={selectedOwner === operator.name ? 'active' : ''} key={operator.name} onClick={() => setSelectedOwner(operator.name)}>{operator.name} <span>{operator.videos}</span></button>)}
    </div>

    <section className="panel table-panel showroom-account-panel">
      <div className="panel-header">
        <div><h2 className="panel-title">精选账号汇总</h2><div className="panel-meta">账号名自动提取 TikTok 用户名后精确匹配；点击账号可只看该账号视频</div></div>
        {selectedHandle && <button className="ghost-button" type="button" onClick={() => setSelectedHandle('')}>清除账号筛选 @{selectedHandle}</button>}
      </div>
      <div className="showroom-account-table table-scroll">
        <table>
          <thead><tr><th>运营人员</th><th>工作台精选账号</th><th>TikTok 账号</th><th>归因视频</th><th>出单</th><th>GMV</th></tr></thead>
          <tbody>{accounts.length ? accounts.map((account) => <tr key={`${account.ownerName}:${account.workspaceAccountId}`} className={selectedHandle && account.handle === selectedHandle ? 'selected' : ''}>
            <td>{account.ownerName}</td><td><strong>{account.workspaceAccountName}</strong></td>
            <td>{account.handle ? <button className="showroom-account-link" type="button" onClick={() => setSelectedHandle(account.handle ?? '')}>@{account.handle}</button> : <span className="muted-text">未识别账号名</span>}</td>
            <td>{number(account.videos)}</td><td><strong>{number(account.orders)}</strong><span className="showroom-duplicate-orders">（TC重复数{number(account.tcDuplicateOrders)}）</span></td><td><strong>{money(account.gmv, account.currency)}</strong></td>
          </tr>) : <tr><td colSpan={6}><div className="empty-state">当前筛选没有精选账号</div></td></tr>}</tbody>
        </table>
      </div>
    </section>

    <section className="panel table-panel showroom-video-panel">
      <div className="panel-header">
        <div><h2 className="panel-title">收益视频明细</h2><div className="panel-meta">仅展示已被 9001 收益订单归因的视频，不把生产库存误算为已发布视频</div></div>
        <div className="showroom-pagination"><button type="button" className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>←</button><span>{page} / {totalPages}</span><button type="button" className="icon-button" aria-label="下一页" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>→</button></div>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>视频 / 商品</th><th>运营 / 账号</th><th>发布时间</th><th>播放</th><th>出单</th><th>GMV</th><th aria-label="打开视频" /></tr></thead>
          <tbody>{visibleVideos.length ? visibleVideos.map((video) => <tr key={video.videoId}>
            <td><div className="showroom-video-product"><EarningsPreview src={video.previewImage} alt={video.productName} /><div className="showroom-video-title"><strong>{video.productName || `视频 ${video.videoId}`}</strong><span>{video.promotionLink ? <a className="showroom-video-link" href={video.promotionLink} target="_blank" rel="noreferrer" title={`打开视频 ${video.videoId}`}>视频 {video.videoId}</a> : <>视频 {video.videoId}</>} · PID {video.productId || '—'}</span></div></div></td>
            <td><strong>{video.ownerName}</strong><div className="muted-text">@{video.creatorUsername}</div></td><td>{localTime(video.publishedAt)}</td><td>{video.playCount === null ? '—' : number(video.playCount)}</td><td><strong>{number(video.orders)}</strong></td><td><strong>{money(video.gmv, video.currency)}</strong></td>
            <td>{video.promotionLink && <a className="icon-button" href={video.promotionLink} target="_blank" rel="noreferrer" title="打开 TikTok 视频" aria-label="打开 TikTok 视频"><ExternalLink size={14} /></a>}</td>
          </tr>) : <tr><td colSpan={7}><div className="empty-state">当前筛选没有已归因的收益视频</div></td></tr>}</tbody>
        </table>
      </div>
    </section>
  </>;
}

function EarningsPreview({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className="showroom-video-preview placeholder" aria-label="暂无商品预览图"><ImageIcon size={20} /></span>;
  }
  return <img className="showroom-video-preview" src={src} alt={alt ? `${alt}预览图` : '商品预览图'} width={64} height={64} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Metric({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return <article className="kpi"><div className="kpi-label"><span>{label}</span><span className="showroom-kpi-icon">{icon}</span></div><div className="kpi-value">{value}</div><div className="kpi-foot">{hint}</div></article>;
}
