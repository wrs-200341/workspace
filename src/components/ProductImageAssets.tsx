'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Download, Image as ImageIcon, Loader2, Search, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePidListText, parsePidRows } from './productImageAssetsModel';

type ProductRecord = { pid: string; importDate: string; files: string[]; relativePath: string };
type GalleryItem = { pid: string; title?: string; description?: string; coverUrl?: string };
type ProductImageAsset = { id: string; pid: string; name: string; importDate: string; mimeType: string };
type ProductFolder = ProductRecord & { images?: ProductImageAsset[]; coverUrl?: string; coverAssetId?: string };

type ProductImagesPayload = {
  success?: boolean;
  data?: { gallery?: GalleryItem[]; imported?: ProductRecord[]; folders?: ProductFolder[] };
  error?: string;
};

/**
 * Shared PID product-image library.
 *
 * The asset page deliberately loads only the local index on mount. 8765 is
 * queried from the dedicated “搜索 PID” dialog so opening an account never
 * performs a remote gallery request (and remains fast when 8765 is offline).
 */
export function ProductImageAssets({ accountId, readOnly = false }: { accountId: string; readOnly?: boolean }) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [pidFileName, setPidFileName] = useState('');
  const [pidFilePids, setPidFilePids] = useState<string[]>([]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [imported, setImported] = useState<ProductRecord[]>([]);
  const [folders, setFolders] = useState<ProductFolder[]>([]);
  const [openFolder, setOpenFolder] = useState<ProductFolder | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const endpoint = `/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images`;

  const loadLocal = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const payload = await response.json() as ProductImagesPayload;
      if (!response.ok || !payload.success) throw new Error(payload.error || '商品图片服务暂不可用');
      setImported(payload.data?.imported ?? []);
      setFolders(payload.data?.folders ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '商品图片加载失败');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);

  const importedPids = useMemo(() => new Set(imported.map((item) => item.pid)), [imported]);

  async function readPidFile(file: File): Promise<string[]> {
    const extension = file.name.toLowerCase().split('.').pop();
    if (extension === 'txt') {
      const text = await file.text();
      return parsePidListText(text);
    }
    if (extension !== 'xlsx' && extension !== 'xls') throw new Error('PID 文件仅支持 .xlsx、.xls 或 .txt');
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', dense: true, raw: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false }) as unknown[][];
    return parsePidRows(rows);
  }

  async function handlePidFile(file: File | undefined) {
    if (!file) return;
    try {
      const pids = await readPidFile(file);
      setPidFileName(file.name);
      setPidFilePids(pids);
      setQuery(pids.join(', '));
      setMessage(pids.length ? `已读取 ${pids.length} 个 PID` : '文件中没有找到有效 PID');
    } catch (error) {
      setPidFileName('');
      setPidFilePids([]);
      setMessage(error instanceof Error ? error.message : 'PID 文件读取失败');
    }
  }

  async function searchGallery(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const manualPids = parsePidListText(query);
    const pids = [...new Set(pidFilePids.length ? pidFilePids : manualPids)].slice(0, 100);
    if (!pids.length) {
      setSubmittedQuery('');
      setGallery([]);
      setMessage('请输入要搜索的 PID');
      return;
    }
    setSubmittedQuery(pids.join(', '));
    setLoading(true);
    setMessage('');
    try {
      const responses: PromiseSettledResult<GalleryItem[]>[] = [];
      for (let index = 0; index < pids.length; index += 8) {
        const batch = await Promise.allSettled(pids.slice(index, index + 8).map(async (pid) => {
          const response = await fetch(`${endpoint}?source=8765&query=${encodeURIComponent(pid)}`, { cache: 'no-store' });
          const payload = await response.json() as ProductImagesPayload;
          if (!response.ok || !payload.success) throw new Error(payload.error || '8765 图库搜索失败');
          return payload.data?.gallery ?? [];
        }));
        responses.push(...batch);
      }
      const fulfilled = responses.filter((result): result is PromiseFulfilledResult<GalleryItem[]> => result.status === 'fulfilled');
      const merged = [...new Map(fulfilled.flatMap((result) => result.value).map((item) => [item.pid, item])).values()];
      if (!merged.length) throw new Error('8765 图库搜索失败');
      if (fulfilled.length < responses.length) setMessage(`部分 PID 未找到，已展示 ${merged.length} 个结果`);
      setGallery(merged);
    } catch (error) {
      setGallery([]);
      setMessage(error instanceof Error ? error.message : '8765 图库搜索失败');
    } finally {
      setLoading(false);
    }
  }

  async function importSelected() {
    if (readOnly || !selected.length) return;
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pids: selected }),
      });
      const payload = await response.json() as ProductImagesPayload;
      if (!response.ok || !payload.success) throw new Error(payload.error || '商品图片导入失败');
      setSelected([]);
      setGallery([]);
      setSubmittedQuery('');
      setSearchOpen(false);
      await loadLocal();
      setMessage('导入完成');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '商品图片导入失败');
    } finally {
      setLoading(false);
    }
  }

  function openSearchDialog() {
    setQuery('');
    setSubmittedQuery('');
    setPidFileName('');
    setPidFilePids([]);
    setGallery([]);
    setSelected([]);
    setSearchOpen(true);
  }

  return (
    <div className={`product-image-assets ${readOnly ? 'read-only' : ''}`}>
      <div className="product-image-toolbar">
        <div>
          <h3 className="product-image-library-title">商品图文件夹</h3>
          <p className="product-image-library-hint">只显示已导入到本地的 PID；需要新商品图时再搜索 8765。</p>
        </div>
        <button type="button" className="primary-button" onClick={openSearchDialog}>
          <Search size={14} /> 搜索 PID
        </button>
      </div>

      {message && <p role="status" className="product-image-message"><Check size={14} />{message}</p>}
      {loading && !searchOpen && <div className="asset-empty"><Loader2 size={16} className="spin" />正在加载本地商品图…</div>}

      <div className="product-imported-list">
        {folders.length ? folders.map((item) => (
          <button type="button" className="asset-row product-folder-row" key={`${item.importDate}-${item.pid}`} onClick={() => setOpenFolder(item)}>
            <span className="product-folder-cover">
              {item.coverUrl ? <img src={item.coverUrl} alt={`${item.pid} 封面`} /> : <ImageIcon size={18} />}
            </span>
            <strong>{item.pid}</strong>
            <span>{item.importDate} · {item.files.length} 张图片</span>
          </button>
        )) : imported.length ? imported.map((item) => (
          <div className="asset-row" key={`${item.importDate}-${item.pid}`}>
            <strong>{item.pid}</strong><span>{item.importDate} · {item.files.length} 张图片</span>
          </div>
        )) : (
          <div className="asset-empty"><ImageIcon size={18} />还没有导入商品图片。点击“搜索 PID”从 8765 导入。</div>
        )}
      </div>

      {searchOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
          <section className="modal-card product-pid-search-modal" role="dialog" aria-modal="true" aria-labelledby="product-pid-search-title">
            <div className="panel-header">
              <div>
                <h2 id="product-pid-search-title" className="panel-title">搜索 8765 PID</h2>
                <div className="panel-meta">搜索结果以 PID 文件夹展示，勾选后可批量下载并保存到本地商品图。</div>
              </div>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setSearchOpen(false)}><X size={15} /></button>
            </div>
            <form className="product-image-search product-pid-search-form" role="search" onSubmit={searchGallery}>
              <label className="sr-only" htmlFor="product-pid-query">搜索 8765 PID</label>
              <input id="product-pid-query" value={query} onChange={(event) => { setQuery(event.target.value); if (pidFilePids.length) { setPidFilePids([]); setPidFileName(''); } }} placeholder="输入 PID" autoFocus />
              <button type="submit" className="ghost-button" disabled={loading}><Search size={14} /> 搜索</button>
            </form>
            <label className="product-pid-file-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void handlePidFile(event.dataTransfer.files?.[0]); }}>
              <input type="file" accept=".xlsx,.xls,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/plain" onChange={(event) => { void handlePidFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
              <span><Download size={15} />拖入或选择 PID 文件</span>
              <small>支持 Excel 第一列 PID，或 TXT 每行一个 PID{pidFileName ? ` · ${pidFileName}（${pidFilePids.length} 个）` : ''}</small>
            </label>
            {message && <p role="status" className="product-image-message">{message}</p>}
            {loading && <div className="asset-empty"><Loader2 size={16} className="spin" />正在搜索 8765…</div>}
            {!loading && submittedQuery && !gallery.length && <div className="asset-empty"><ImageIcon size={18} />没有匹配的 PID。</div>}
            {!loading && gallery.length > 0 && (
              <>
                <div className="product-pid-search-actions">
                  <span>找到 {gallery.length} 个 PID</span>
                  {!readOnly && <button type="button" className="primary-button" onClick={() => void importSelected()} disabled={!selected.length}><Download size={14} /> 导入选中 ({selected.length})</button>}
                </div>
                <div className="product-gallery-grid">
                  {gallery.map((item) => {
                    const alreadyImported = importedPids.has(item.pid);
                    const checked = selected.includes(item.pid);
                    return (
                      <article className={`product-gallery-card ${alreadyImported ? 'imported' : ''}`} key={item.pid}>
                        <label>
                          <input type="checkbox" checked={checked} disabled={readOnly || alreadyImported} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, item.pid])] : current.filter((pid) => pid !== item.pid))} />
                          <strong>{item.pid}</strong>
                          {alreadyImported && <small>已导入</small>}
                        </label>
                        {item.coverUrl ? <img src={item.coverUrl} alt={`${item.pid} 商品封面`} /> : <div className="product-cover-placeholder"><ImageIcon size={24} /></div>}
                        <span>{item.title || '未提供标题'}</span>
                        <small>{item.description || '暂无描述'}</small>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {openFolder && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenFolder(null); }}>
          <section className="modal-card product-folder-modal" role="dialog" aria-modal="true" aria-labelledby="product-folder-title">
            <div className="panel-header">
              <div>
                <h2 id="product-folder-title" className="panel-title">PID {openFolder.pid} 图片</h2>
                <div className="panel-meta">文件夹内图片保持 9:16 比例，可在生产界面继续选择。</div>
              </div>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setOpenFolder(null)}><X size={15} /></button>
            </div>
            <div className="product-folder-grid">
              {(openFolder.images ?? []).map((asset) => <figure key={asset.id}><img src={`/api/workspace/product-images/preview?assetId=${encodeURIComponent(asset.id)}`} alt={asset.name} /><figcaption>{asset.name}</figcaption></figure>)}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
