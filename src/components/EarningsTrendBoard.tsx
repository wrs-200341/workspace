'use client';

import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { aggregateEarnings, formatCompact, type EarningsRow } from '@/lib/earningsTrend';

export function EarningsTrendBoard() {
  const [range, setRange] = useState('week');
  const [rows, setRows] = useState<EarningsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setLoading(true); setError('');
    try { const response = await fetch(`/api/earnings-trend?range=${range}`, { cache:'no-store' }); if (!response.ok) throw new Error('数据源暂不可用'); const json = await response.json(); if (Array.isArray(json.data)) setRows(json.data); }
    catch (e) { setError(e instanceof Error ? e.message : '数据源暂不可用'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [range]);
  const data = useMemo(() => aggregateEarnings(rows), [rows]);
  // Keep the empty state truthful. A baseline of one would imply a fabricated
  // order when no upstream rows have been synchronised yet.
  const max = data.length ? Math.max(...data.map(item => item.orders), 0) : 0;
  const scale = max || 1;
  const points = data.map((item, index) => `${(index / Math.max(data.length - 1, 1)) * 100},${220 - (item.orders / scale) * 172}`).join(' ');
  return <section className="panel">
    <div className="panel-header"><div><h2 className="panel-title">每日出单趋势</h2><div className="panel-meta">来自 9001 · 按北京时间聚合</div></div><div className="toolbar"><select className="select" value={range} onChange={e => setRange(e.target.value)} aria-label="趋势时间范围"><option value="week">近 7 天</option><option value="month">近 30 天</option><option value="year">近一年</option></select><button className="ghost-button" onClick={() => void refresh()} aria-label="刷新出单趋势"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div></div>
    <div className="chart-wrap">{error && <div role="alert" aria-live="polite" style={{ color:'#b45309', fontSize:12, margin:'4px 4px 8px' }}>{error}，当前展示最近缓存。</div>}<svg className="chart" viewBox="0 0 100 250" preserveAspectRatio="none" role="img" aria-label="每日订单数量趋势折线图"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#1e40af" stopOpacity=".18" /><stop offset="1" stopColor="#1e40af" stopOpacity="0" /></linearGradient></defs><line className="chart-grid" x1="0" x2="100" y1="48" y2="48" /><line className="chart-grid" x1="0" x2="100" y1="105" y2="105" /><line className="chart-grid" x1="0" x2="100" y1="162" y2="162" /><line className="chart-grid" x1="0" x2="100" y1="220" y2="220" /><polygon className="chart-area" points={`0,220 ${points} 100,220`} /><polyline className="chart-line" points={points} vectorEffect="non-scaling-stroke" />{data.map((item,index) => <text key={item.date} className="chart-label" x={`${(index / Math.max(data.length - 1,1))*100}`} y="242" textAnchor={index === 0 ? 'start' : index === data.length-1 ? 'end' : 'middle'}>{item.date.slice(5)}</text>)}</svg><table className="sr-only"><caption>每日订单数量数据</caption><thead><tr><th>日期</th><th>订单</th></tr></thead><tbody>{data.map(item => <tr key={item.date}><td>{item.date}</td><td>{item.orders}</td></tr>)}</tbody></table><div className="legend"><span className="legend-item"><i className="legend-swatch" />订单数</span><span className="legend-item" style={{ marginLeft:'auto' }}>峰值 {formatCompact(max)} 单</span></div></div>
  </section>;
}
