import Link from 'next/link';
import { ArrowLeft, AudioLines, FileImage, Film, FileText, Plus } from 'lucide-react';
import { getWorkspaceAccountById } from '@/lib/workspace/data';
import { listStoredAccounts } from '@/lib/workspace/accountStore';
import { listAssets, type AssetKind } from '@/lib/workspace/assetStore';
import { ProductImageAssets } from './ProductImageAssets';
import { AccountAssetLibrary } from './AccountAssetLibrary';
import { repairSavedVideoTaskInventory } from '@/lib/workspace/videoInventory';

export type ImageAssetTab = 'materials' | 'products';
export type PromptAssetTab = 'image' | 'video';
type Props = { accountId: string; section?: AssetKind; imageTab?: ImageAssetTab; promptTab?: PromptAssetTab; readOnly?: boolean };

const sections: Array<{ id: AssetKind; label: string; icon: typeof FileText }> = [
  { id: 'prompt', label: '提示词', icon: FileText },
  { id: 'image', label: '图片', icon: FileImage },
  { id: 'inventory-video', label: '库存视频', icon: Film },
  { id: 'audio', label: '音频', icon: AudioLines },
];

const sectionPath: Record<AssetKind, string> = {
  prompt: 'prompts',
  image: 'images',
  'inventory-video': 'videos',
  audio: 'audio',
};

const productionMode: Record<AssetKind, string> = {
  prompt: 'prompt',
  image: 'image',
  'inventory-video': 'video',
  audio: 'video',
};

function sectionDescription(section: AssetKind): string {
  if (section === 'prompt') return '把高频提示词保存为模板，在生图和生视频时快速准备材料。';
  if (section === 'image') return '素材图片和商品图片分开管理，商品图片来自 8765 PID 图库服务。';
  if (section === 'inventory-video') return '已完成并准备入库的视频成品。';
  return '口播、环境声和配乐素材。';
}

export async function AccountAssetsPage({ accountId, section = 'prompt', imageTab = 'materials', promptTab = 'video', readOnly = false }: Props) {
  // Inventory repair may need to download a provider result. Do not block
  // route rendering on that remote work; the library's client refresh will
  // pick up repaired assets once the background pass completes.
  if (section === 'inventory-video') void repairSavedVideoTaskInventory([accountId]);
  const workspaceAccount = listStoredAccounts().find((item) => item.id === accountId) ?? getWorkspaceAccountById(accountId);
  // Account assets belong to the workspace account store.  Do not fall back
  // to the legacy mock account catalogue: those records contain presentation
  // placeholders rather than live account identities or counters.
  const displayName = workspaceAccount?.name ?? accountId;
  // Sidebar counters are scoped to this account's private workspace assets.
  // Shared 8765 product/PID images are shown in the product sub-tab and must
  // not be duplicated into every operator account's image count.
  const counts = Object.fromEntries(sections.map(({ id }) => [id, listAssets(accountId, id).length])) as Record<AssetKind, number>;
  const currentLabel = sections.find((item) => item.id === section)?.label ?? '提示词';

  return <>
    <div className="asset-page-heading">
      <div>
        <Link href="/workspace" className="asset-breadcrumb"><ArrowLeft size={14} /> 工作台 / 账号资产</Link>
        <div className="eyebrow">{workspaceAccount?.ownerName ?? '精选账号'}</div>
        <h1>{displayName}<span className="asset-heading-accent"> 数据资产</span></h1>
      </div>
      <div className="toolbar">{!readOnly && <Link href={`/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${productionMode[section]}`} className="primary-button" style={{ textDecoration: 'none' }}><Plus size={14} /> 新建生产任务</Link>}</div>
    </div>
    <div className="asset-layout">
      <aside className="asset-sidebar panel">
        <div className="asset-sidebar-title">DATA ASSETS</div>
        {sections.map(({ id, label, icon: SectionIcon }) => <Link key={id} href={`/workspace/accounts/${encodeURIComponent(accountId)}/assets/${sectionPath[id]}`} className={`asset-nav-item ${section === id ? 'active' : ''}`}>
          <span><SectionIcon size={16} />{label}</span>
          <strong>{counts[id] ?? 0}</strong>
        </Link>)}
      </aside>
      <section className="asset-content panel">
        <div className="asset-content-header">
          <div><div className="eyebrow">精选账号</div><h2>{currentLabel}</h2><p>{sectionDescription(section)}</p></div>
          <span className="asset-count-badge">{counts[section]} 项</span>
        </div>
        {section === 'image' ? <ImageAssets accountId={accountId} tab={imageTab} assets={listAssets(accountId, 'image')} readOnly={readOnly} /> : <AccountAssetLibrary accountId={accountId} section={section} initialAssets={listAssets(accountId, section)} promptTab={promptTab} readOnly={readOnly} />}
      </section>
    </div>
  </>;
}

function ImageAssets({ accountId, tab, assets, readOnly }: { accountId: string; tab: ImageAssetTab; assets: ReturnType<typeof listAssets>; readOnly: boolean }) {
  return <div className="image-assets-panel">
    <nav className="asset-secondary-tabs" aria-label="图片资产分类" role="tablist">
      <Link href={`/workspace/accounts/${encodeURIComponent(accountId)}/assets/images?tab=materials`} role="tab" aria-selected={tab === 'materials'} className={`asset-secondary-tab ${tab === 'materials' ? 'active' : ''}`}>素材图片<span>本地上传</span></Link>
      <Link href={`/workspace/accounts/${encodeURIComponent(accountId)}/assets/images?tab=products`} role="tab" aria-selected={tab === 'products'} className={`asset-secondary-tab ${tab === 'products' ? 'active' : ''}`}>商品图片<span>8765 PID</span></Link>
    </nav>
    {tab === 'products' ? <><AccountAssetLibrary accountId={accountId} section="image" initialAssets={assets} readOnly={readOnly} /><ProductImageAssets accountId={accountId} readOnly={readOnly} /></> : <AccountAssetLibrary accountId={accountId} section="image" initialAssets={assets} readOnly={readOnly} />}
  </div>;
}
