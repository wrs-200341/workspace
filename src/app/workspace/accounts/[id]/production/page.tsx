import Link from 'next/link';
import { ArrowLeft, WandSparkles } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { ProductionForm } from '@/components/ProductionForm';
import { requirePageRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { redirect } from 'next/navigation';
import { ProductionQueue } from '@/components/ProductionQueue';
import { listStoredAccounts } from '@/lib/workspace/accountStore';
import { getWorkspaceAccountById } from '@/lib/workspace/data';

type ProductionMode = 'image' | 'prompt' | 'video';
const modeLinks: Array<{ id: ProductionMode; label: string; code: string }> = [
  { id: 'image', label: '生图', code: 'IMAGE' },
  { id: 'prompt', label: '生成提示词', code: 'PROMPT' },
  { id: 'video', label: '生成视频', code: 'VIDEO' },
];
function normalizeMode(value: string | string[] | undefined): ProductionMode {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === 'image' || candidate === 'prompt' || candidate === 'video' ? candidate : 'video';
}
function stringQuery(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

export default async function ProductionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ mode?: string | string[]; focusTaskId?: string | string[]; queueDate?: string | string[]; focusTaskDate?: string | string[] }> }) {
  const { id } = await params;
  const query = searchParams ? await searchParams : {};
  const mode = normalizeMode(query.mode);
  const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/production`);
  if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden');
  const readOnly = !canAccessWorkspaceAccount(user, id, { write: true });
  const account = listStoredAccounts().find((item) => item.id === id) ?? getWorkspaceAccountById(id);
  const queueDate = stringQuery(query.queueDate) ?? stringQuery(query.focusTaskDate);
  return <AppShell user={user}>
    <div className="asset-page-heading">
      <div><Link href="/workspace" className="asset-breadcrumb"><ArrowLeft size={14} /> 工作台 / 生产</Link><div className="eyebrow">{account?.ownerName ?? '运营账号'} · Production Desk{readOnly ? ' · 只读查看' : ''}</div><h1>{account?.name ?? id} · {mode === 'image' ? '图片生产' : mode === 'prompt' ? '提示词生成' : '视频生产'}</h1><p className="subtitle">{readOnly ? '当前为其他运营账号工作台，只能查看任务与审核结果。' : '选择模型、准备参考素材，然后创建可追踪的生产任务。'}</p></div>
      <Link href={`/workspace/accounts/${encodeURIComponent(id)}/assets`} className="ghost-button" style={{ textDecoration: 'none' }}>账号资产</Link>
    </div>
    <nav aria-label="生产模式" className="production-tabs panel">{modeLinks.map((item) => <Link key={item.id} href={`/workspace/accounts/${encodeURIComponent(id)}/production?mode=${item.id}`} className={`production-tab ${mode === item.id ? 'active' : ''}`}><span>{item.code}</span>{item.label}</Link>)}</nav>
    <div className={`section-grid content-grid ${mode === 'prompt' ? 'production-prompt-only' : ''}`}>
      {readOnly ? <section className="panel read-only-notice"><div className="panel-header"><div><h2 className="panel-title">只读工作台</h2><div className="panel-meta">可查看该运营账号的历史任务、生产队列和审核结果</div></div></div><p>你当前可以查看此工作区的资产和任务，但不能新建、编辑、删除或入库。</p></section> : <section className="panel"><div className="panel-header"><div><h2 className="panel-title">{mode === 'image' ? '创建图片任务' : mode === 'prompt' ? '创建提示词任务' : '创建视频任务'}</h2><div className="panel-meta">参数和素材会按账号保存，任务创建后可在生产队列和审核页面继续复核。</div></div><WandSparkles size={16} color="#1e40af" /></div><ProductionForm accountId={id} mode={mode} /></section>}
      {mode !== 'prompt' && <ProductionQueue accountId={id} mode={mode} readOnly={readOnly} ownerId={readOnly ? account?.ownerId : undefined} focusTaskId={stringQuery(query.focusTaskId)} queueDate={queueDate} />}
    </div>
  </AppShell>;
}
