'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Download, Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react';

type ProductRecord = { pid: string; importDate: string; files: string[]; relativePath: string };
type GalleryItem = { pid: string; title?: string; description?: string; coverUrl?: string };

export function ProductImageAssets({ accountId, readOnly = false }: { accountId: string; readOnly?: boolean }) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [imported, setImported] = useState<ProductRecord[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async (search = '') => {
    setLoading(true); setMessage('');
    try {
      const params = search.trim() ? `?source=8765&query=${encodeURIComponent(search.trim())}` : '?source=8765';
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images${params}`, { cache: 'no-store' });
      const payload = await response.json() as { success?: boolean; data?: { gallery?: GalleryItem[]; imported?: ProductRecord[] }; error?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || '商品图片服务暂不可用');
      setGallery(payload.data?.gallery ?? []); setImported(payload.data?.imported ?? []);
    } catch (error) { setMessage(error instanceof Error ? error.message : '商品图片加载失败'); }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);
  const importedPids = useMemo(() => new Set(imported.map((item) => item.pid)), [imported]);

  async function importSelected() {
    if (readOnly || !selected.length) return;
    setLoading(true); setMessage('');
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pids: selected }) });
      const payload = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || '商品图片导入失败');
      setSelected([]); setMessage('导入完成'); await load(submittedQuery);
    } catch (error) { setMessage(error instanceof Error ? error.message : '商品图片导入失败'); }
    finally { setLoading(false); }
  }

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const next = query.trim(); setSubmittedQuery(next); void load(next); };
  return <div className={`product-image-assets ${readOnly ? 'read-only' : ''}`}>
    <div className="product-image-toolbar"><form className="product-image-search" role="search" onSubmit={submitSearch}><label className="sr-only" htmlFor="product-pid-query">搜索 8765 PID</label><input id="product-pid-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入 PID、标题或描述" /><button type="submit" className="ghost-button" disabled={loading}><RefreshCw size={14} /> 查询</button></form><button type="button" className="primary-button" onClick={() => void importSelected()} disabled={loading || !selected.length}><Download size={14} /> 导入选中 ({selected.length})</button></div>
    {message && <p role="status" className="product-image-message"><Check size={14} />{message}</p>}
    {loading && <div className="asset-empty"><Loader2 size={16} className="spin" />正在加载商品图片…</div>}
    {!loading && submittedQuery && !gallery.length && <div className="asset-empty"><ImageIcon size={18} />没有匹配的 PID 或商品。</div>}
    {!loading && !submittedQuery && !gallery.length && <div className="asset-empty"><ImageIcon size={18} />当前没有可显示的 8765 PID；请查询后选择导入。</div>}
    {!loading && gallery.length > 0 && <div className="product-gallery-grid">{gallery.map((item) => { const alreadyImported = importedPids.has(item.pid); return <article className={`product-gallery-card ${alreadyImported ? 'imported' : ''}`} key={item.pid}><label><input type="checkbox" checked={selected.includes(item.pid)} disabled={alreadyImported} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, item.pid])] : current.filter((pid) => pid !== item.pid))} /><strong>{item.pid}</strong>{alreadyImported && <small>已导入</small>}</label>{item.coverUrl ? <img src={item.coverUrl} alt={`${item.pid} 商品封面`} /> : <div className="product-cover-placeholder"><ImageIcon size={24} /></div>}<span>{item.title || '未提供标题'}</span><small>{item.description || '暂无描述'}</small></article>; })}</div>}
    <h3>已导入商品图片</h3><div className="product-imported-list">{imported.length ? imported.map((item) => <div className="asset-row" key={`${item.importDate}-${item.pid}`}><strong>{item.pid}</strong><span>{item.importDate} · {item.files.length} 张图片</span></div>) : <div className="asset-empty"><ImageIcon size={18} />还没有导入商品图片。</div>}</div>
  </div>;
}
