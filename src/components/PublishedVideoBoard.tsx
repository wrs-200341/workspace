'use client';

import { CalendarDays, CircleDollarSign, ExternalLink, ImageIcon, Link2, RefreshCw, Search, Send, ShoppingCart } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PublishedPerformance } from '@/lib/workspace/publishedPerformance';

type RangeKey = 'all' | 'today' | '7d' | '30d';
type PidSort = 'orders' | 'latest';
type ApiPayload = { success?: boolean; stale?: boolean; syncedAt?: string; data?: PublishedPerformance };

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: '7d', label: '近 7 日' },
  { key: '30d', label: '近 30 日' },
];
const VIDEO_PAGE_SIZE = 40;

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
  if (!value) return '发布时间待回写';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.replace('T', ' ') : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function PublishedVideoBoard() {
  const [range, setRange] = useState<RangeKey>('all');
  const [data, setData] = useState<PublishedPerformance | null>(null);
  const [selectedPid, setSelectedPid] = useState('');
  const [query, setQuery] = useState('');
  const [pidSort, setPidSort] = useState<PidSort>('orders');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [syncedAt, setSyncedAt] = useState('');

  const load = useCallback(async (force = false, signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/published-performance?range=${range}${force ? '&refresh=1' : ''}`, { cache: 'no-store', signal });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success || !payload.data) throw new Error('load_failed');
      setData(payload.data);
      setStale(Boolean(payload.stale));
      setSyncedAt(payload.syncedAt ?? '');
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError('发布或收益数据暂时不可用，请稍后重试');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => { setSelectedPid(''); setPage(1); }, [range]);
  useEffect(() => { setPage(1); }, [query, selectedPid]);

  const normalizedQuery = query.trim().toLowerCase();
  const pids = useMemo(() => {
    const filtered = (data?.pids ?? []).filter((row) => !normalizedQuery
      || `${row.productPid} ${row.productName}`.toLowerCase().includes(normalizedQuery));
    return [...filtered].sort((a, b) => {
      if (pidSort === 'orders') {
        return b.orders - a.orders
          || b.gmv - a.gmv
          || b.videos - a.videos
          || b.latestPublishedAt.localeCompare(a.latestPublishedAt)
          || a.productPid.localeCompare(b.productPid);
      }
      return b.latestPublishedAt.localeCompare(a.latestPublishedAt)
        || b.videos - a.videos
        || a.productPid.localeCompare(b.productPid);
    });
  }, [data, normalizedQuery, pidSort]);
  const videos = useMemo(() => (data?.videos ?? []).filter((video) => {
    if (selectedPid && video.productPid !== selectedPid) return false;
    if (!normalizedQuery) return true;
    return `${video.productPid} ${video.productName} ${video.videoId} ${video.accountName} ${video.accountUsername} ${video.accountOwner} ${video.publishingOperator}`.toLowerCase().includes(normalizedQuery);
  }), [data, normalizedQuery, selectedPid]);
  const scopedTotals = useMemo(() => ({
    pids: new Set(videos.map((video) => video.productPid || '未识别 PID')).size,
    videos: videos.length,
    attributedVideos: videos.filter((video) => video.earningsMatched).length,
    orders: videos.reduce((sum, video) => sum + video.orders, 0),
    tcDuplicateOrders: videos.reduce((sum, video) => sum + video.tcDuplicateOrders, 0),
    gmv: videos.reduce((sum, video) => sum + video.gmv, 0),
    currency: videos.length && videos.every((video) => video.currency === videos[0].currency) ? videos[0].currency : videos.length ? 'MIXED' : data?.totals.currency ?? 'MXN',
  }), [data, videos]);
  const totalPages = Math.max(1, Math.ceil(videos.length / VIDEO_PAGE_SIZE));
  const visibleVideos = videos.slice((page - 1) * VIDEO_PAGE_SIZE, page * VIDEO_PAGE_SIZE);

  return <>
    <div className="page-heading showroom-heading">
      <div><div className="eyebrow">Publishing / performance</div><h1>发布视频统计</h1><p className="subtitle">成功发布以 8766 为准，订单和 GMV 来自 9001。</p></div>
      <div className="toolbar"><span className={`service-pill ${stale ? 'attention' : ''}`}><span className="dot" /> {stale ? '使用最近同步数据' : '8766 发布 · 9001 收益'}</span><button className="icon-button" type="button" title="刷新发布统计" aria-label="刷新发布统计" disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    </div>

    <div className="showroom-controls" aria-label="发布统计筛选">
      <div className="showroom-segments" aria-label="发布时间范围">{RANGE_OPTIONS.map((item) => <button key={item.key} type="button" className={range === item.key ? 'active' : ''} onClick={() => setRange(item.key)}>{item.label}</button>)}</div>
      <label className="showroom-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 PID、商品、账号或视频 ID" aria-label="搜索 PID、商品、账号或视频 ID" /></label>
      <span className="showroom-sync-time"><CalendarDays size={14} /> {syncedAt ? `同步于 ${localTime(syncedAt)}` : '等待同步'}</span>
    </div>

    {error && <div className="showroom-error" role="alert">{error}<button type="button" onClick={() => void load(true)}>重试</button></div>}

    <div className="section-grid kpi-grid showroom-kpis" aria-busy={loading}>
      <Metric icon={<Send size={17} />} label="成功发布" value={number(scopedTotals.videos)} hint={`${number(scopedTotals.pids)} 个 PID`} />
      <Metric icon={<Link2 size={17} />} label="已匹配收益" value={number(scopedTotals.attributedVideos)} hint="按视频 ID 精确匹配" />
      <Metric icon={<ShoppingCart size={17} />} label="出单" value={number(scopedTotals.orders)} hint={`TC 重复数 ${number(scopedTotals.tcDuplicateOrders)}`} />
      <Metric icon={<CircleDollarSign size={17} />} label="GMV" value={money(scopedTotals.gmv, scopedTotals.currency)} hint="沿用 9001 我的收益口径" />
    </div>

    <section className="panel table-panel publishing-pid-panel">
      <div className="panel-header"><div><h2 className="panel-title">PID 发布汇总</h2><div className="panel-meta">{number(pids.length)} 个 PID</div></div><div className="toolbar"><select className="select" value={pidSort} onChange={(event) => setPidSort(event.target.value as PidSort)} aria-label="PID 汇总排序"><option value="orders">出单量从多到少</option><option value="latest">最新发布优先</option></select>{selectedPid && <button className="ghost-button" type="button" onClick={() => setSelectedPid('')}>清除 PID 筛选 {selectedPid}</button>}</div></div>
      <div className="publishing-pid-table table-scroll"><table><thead><tr><th>PID / 商品</th><th>发布视频</th><th>收益视频</th><th>出单</th><th>GMV</th><th>最近发布</th></tr></thead><tbody>
        {pids.length ? pids.map((row) => <tr key={row.productPid} className={selectedPid === row.productPid ? 'selected' : ''} onClick={() => setSelectedPid(row.productPid)}>
          <td><div className="showroom-video-product publishing-product"><Preview src={row.previewImage} alt={row.productName} /><div className="showroom-video-title"><strong>{row.productPid}</strong><span title={row.productName || undefined}>{row.productName || '商品名称待同步'}</span></div></div></td>
          <td><strong>{number(row.videos)}</strong>{row.linkedVideos < row.videos && <span className="publishing-link-pending">{number(row.videos - row.linkedVideos)} 条链接待回写</span>}</td><td>{number(row.attributedVideos)}</td><td><strong>{number(row.orders)}</strong><span className="showroom-duplicate-orders">（TC重复数{number(row.tcDuplicateOrders)}）</span></td><td><strong>{money(row.gmv, row.currency)}</strong></td><td>{localTime(row.latestPublishedAt)}</td>
        </tr>) : <tr><td colSpan={6}><div className="empty-state">当前筛选没有成功发布记录</div></td></tr>}
      </tbody></table></div>
    </section>

    <section className="panel table-panel showroom-video-panel">
      <div className="panel-header"><div><h2 className="panel-title">发布视频明细</h2><div className="panel-meta">{selectedPid ? `PID ${selectedPid}` : '全部成功发布视频'} · {number(videos.length)} 条</div></div><div className="showroom-pagination"><button type="button" className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>←</button><span>{page} / {totalPages}</span><button type="button" className="icon-button" aria-label="下一页" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>→</button></div></div>
      <div className="table-scroll"><table><thead><tr><th>视频 / 商品</th><th>PID</th><th>运营 / 发布账号</th><th>发布时间</th><th>出单</th><th>GMV</th><th aria-label="打开视频" /></tr></thead><tbody>
        {visibleVideos.length ? visibleVideos.map((video) => <tr key={video.targetId}>
          <td><div className="showroom-video-product"><Preview src={video.previewImage} alt={video.productName} /><div className="showroom-video-title"><strong>{video.productName || video.publishTitle || `发布任务 ${video.jobId}`}</strong><span>{video.videoId ? `视频 ${video.videoId}` : '视频链接待回写'}</span></div></div></td><td><button type="button" className="showroom-account-link" onClick={() => setSelectedPid(video.productPid)}>{video.productPid || '未识别 PID'}</button></td>
          <td><strong>{video.accountOwner || video.publishingOperator || '未分配'}</strong><div className="muted-text">@{video.accountUsername || video.accountName || '未知账号'}</div></td><td>{localTime(video.publishedAt)}</td><td><strong>{number(video.orders)}</strong>{video.tcDuplicateOrders > 0 && <span className="showroom-duplicate-orders">（TC重复数{number(video.tcDuplicateOrders)}）</span>}</td><td><strong>{money(video.gmv, video.currency)}</strong></td>
          <td>{video.videoUrl && <a className="icon-button" href={video.videoUrl} target="_blank" rel="noreferrer" title="打开已发布视频" aria-label="打开已发布视频"><ExternalLink size={14} /></a>}</td>
        </tr>) : <tr><td colSpan={7}><div className="empty-state">当前筛选没有成功发布视频</div></td></tr>}
      </tbody></table></div>
    </section>
  </>;
}

function Preview({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="showroom-video-preview placeholder" aria-label="暂无商品预览图"><ImageIcon size={20} /></span>;
  return <img className="showroom-video-preview" src={src} alt={alt ? `${alt}预览图` : '商品预览图'} width={64} height={64} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Metric({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return <article className="kpi"><div className="kpi-label"><span>{label}</span><span className="showroom-kpi-icon">{icon}</span></div><div className="kpi-value">{value}</div><div className="kpi-foot">{hint}</div></article>;
}
