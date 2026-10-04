import Link from 'next/link';
import { Archive, CheckCircle2, RefreshCcw, Send } from 'lucide-react';
import { listProviderGenerationDailyStats } from '@/lib/providers/providerGenerationStats';

type GenerationStatsFilters = {
  from?: string;
  to?: string;
  range?: string;
};

const SHANGHAI_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function today(): string {
  return SHANGHAI_DATE.format(new Date());
}

function offsetDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return SHANGHAI_DATE.format(new Date(Date.UTC(year, month - 1, day + days, 4)));
}

function resolvedFilters(filters: GenerationStatsFilters): { from?: string; to?: string; range: string } {
  const end = today();
  if (filters.range === 'today') return { from: end, to: end, range: 'today' };
  if (filters.range === '7d') return { from: offsetDate(end, -6), to: end, range: '7d' };
  if (filters.range === '30d') return { from: offsetDate(end, -29), to: end, range: '30d' };
  if (filters.range === 'all') return { range: 'all' };
  const from = filters.from?.trim() || undefined;
  const to = filters.to?.trim() || undefined;
  return { from, to, range: from || to ? 'custom' : 'all' };
}

function number(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function GenerationStatsPage({ filters }: { filters: GenerationStatsFilters }) {
  const resolved = resolvedFilters(filters);
  const daily = listProviderGenerationDailyStats({ from: resolved.from, to: resolved.to });
  const presets = [
    { value: 'today', label: '今天' },
    { value: '7d', label: '近 7 天' },
    { value: '30d', label: '近 30 天' },
    { value: 'all', label: '全部' },
  ];
  const kpis = [
    { label: '总调用次数', value: daily.totals.calls, icon: Send, foot: '当前时间范围内的生图和生视频任务' },
    { label: '总成功次数', value: daily.totals.successes, icon: CheckCircle2, foot: `当前时间范围成功率 ${percent(daily.totals.successRate)}` },
    { label: '成功任务恢复', value: daily.totals.successfulRestores, icon: RefreshCcw, foot: '成功任务再次恢复配置的次数' },
    { label: '失败任务恢复', value: daily.totals.failedRestores, icon: RefreshCcw, foot: '失败任务人工恢复的次数' },
    { label: '总入库次数', value: daily.totals.inventories, icon: Archive, foot: '当前时间范围内首次入库的任务' },
  ];

  return <>
    <div className="page-heading generation-stats-heading">
      <div>
        <div className="eyebrow">Provider / generation metrics</div>
        <h1>生成统计</h1>
        <p className="subtitle">按供应商统计生图和生视频任务，不包含子提示词模型。</p>
      </div>
      <span className="service-pill"><span className="dot" /> SQLite 实时统计</span>
    </div>

    <div className="showroom-controls generation-stats-controls">
      <nav className="showroom-segments generation-stats-presets" aria-label="每日明细时间范围">
        {presets.map((preset) => <Link key={preset.value} href={`/generation-stats?range=${preset.value}`} className={resolved.range === preset.value ? 'active' : ''}>{preset.label}</Link>)}
      </nav>
      <form className="generation-stats-date-form" method="get">
        <label>开始日期<input className="select" type="date" name="from" defaultValue={resolved.from ?? ''} /></label>
        <label>结束日期<input className="select" type="date" name="to" defaultValue={resolved.to ?? ''} /></label>
        <button className="primary-button" type="submit">查询</button>
      </form>
    </div>

    <section className="section-grid kpi-grid generation-stats-kpis">
      {kpis.map(({ label, value, icon: Icon, foot }) => <article className="kpi" key={label}>
        <div className="kpi-label"><span>{label}</span><Icon size={18} /></div>
        <div className="kpi-value">{number(value)}</div>
        <div className="kpi-foot">{foot}</div>
      </article>)}
    </section>

    <section className="panel generation-stats-panel">
      <div className="panel-header">
        <div><h2 className="panel-title">每日供应商明细</h2><div className="panel-meta">按北京时间逐日统计，同一天内按调用次数排序</div></div>
        <div className="generation-stats-range-summary"><span>{resolved.from || resolved.to ? `${resolved.from ?? '最早'} 至 ${resolved.to ?? '今天'}` : '全部日期'}</span><strong>调用 {number(daily.totals.calls)} · 成功 {number(daily.totals.successes)} · 成功恢复 {number(daily.totals.successfulRestores)} · 失败恢复 {number(daily.totals.failedRestores)} · 入库 {number(daily.totals.inventories)}</strong></div>
      </div>
      <div className="table-scroll generation-stats-table">
        <table>
          <thead><tr><th>日期</th><th>供应商</th><th>任务类型</th><th>调用次数</th><th>成功次数</th><th>成功任务恢复</th><th>失败任务恢复</th><th>入库次数</th></tr></thead>
          <tbody>{daily.rows.length ? daily.rows.map((row, index) => <tr key={`${row.businessDate}:${row.provider}:${row.mode}`} className={index === 0 || daily.rows[index - 1].businessDate !== row.businessDate ? 'generation-day-start' : ''}>
            <td><strong className="generation-business-date">{row.businessDate}</strong></td><td><strong>{row.providerName}</strong><small>{row.provider}</small></td>
            <td><span className={`generation-mode ${row.mode}`}>{row.mode === 'image' ? '生图' : '生视频'}</span></td>
            <td>{number(row.calls)}</td><td>{number(row.successes)}</td><td>{number(row.successfulRestores)}</td><td>{number(row.failedRestores)}</td><td>{number(row.inventories)}</td>
          </tr>) : <tr><td colSpan={8}><div className="empty-state">当前时间范围暂无生成记录</div></td></tr>}</tbody>
        </table>
      </div>
      <div className="generation-stats-note">调用、成功和入库次数已根据现存历史任务补齐；成功任务恢复与失败任务恢复分开统计，并从 2026-09-29 起准确记录。系统自动重试不计入恢复次数，删除任务后统计事件仍会保留。</div>
    </section>
  </>;
}
