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
  { id: 'prompt', label: '生提示词', code: 'PROMPT' },
  { id: 'video', label: '生视频', code: 'VIDEO' },
];
function normalizeMode(value: string | string[] | undefined): ProductionMode { const candidate = Array.isArray(value) ? value[0] : value; return candidate === 'image' || candidate === 'prompt' || candidate === 'video' ? candidate : 'video'; }

export default async function ProductionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ mode?: string | string[] }> }) {
  const { id } = await params; const query = searchParams ? await searchParams : {}; const mode = normalizeMode(query.mode); const user = await requirePageRole(['admin', 'workspace', 'operator'], `/workspace/accounts/${id}/production`); if (!canAccessWorkspaceAccount(user, id)) redirect('/forbidden');
  const account = listStoredAccounts().find((item) => item.id === id) ?? getWorkspaceAccountById(id);
  return <AppShell user={user}><div className="asset-page-heading"><div><Link href="/workspace" className="asset-breadcrumb"><ArrowLeft size={14} /> 工作台 / 生产</Link><div className="eyebrow">{account?.category === 'featured' ? '精选账号' : '运营账号'} · Production Desk</div><h1>{account?.name ?? id} · {mode === 'image' ? '图片生产' : mode === 'prompt' ? '提示词生产' : '视频生产'}</h1><p className="subtitle">选择历史 provider、准备参考素材，然后创建可追踪的生产任务。</p></div><Link href={`/workspace/accounts/${id}/assets`} className="ghost-button" style={{ textDecoration: 'none' }}>账号资产</Link></div><nav aria-label="生产模式" className="production-tabs panel">{modeLinks.map((item) => <Link key={item.id} href={`/workspace/accounts/${id}/production?mode=${item.id}`} className={`production-tab ${mode === item.id ? 'active' : ''}`}><span>{item.code}</span>{item.label}</Link>)}</nav><div className={`section-grid content-grid ${mode === 'prompt' ? 'production-prompt-only' : ''}`}><section className="panel"><div className="panel-header"><div><h2 className="panel-title">{mode === 'image' ? '创建图片任务' : mode === 'prompt' ? '创建提示词任务' : '创建视频任务'}</h2><div className="panel-meta">参数和素材会按账号保存，任务创建后可以在资产页和任务详情里继续复核。</div></div><WandSparkles size={16} color="#1e40af" /></div><ProductionForm accountId={id} mode={mode} /></section>{mode !== 'prompt' && <ProductionQueue accountId={id} mode={mode} />}</div></AppShell>;
}
