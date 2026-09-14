'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Download, Image as ImageIcon, Loader2, Search, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { formatProviderErrorWithDetail } from '@/lib/providers/errorMessages';
import { normalizeProductGalleryItems, parsePidListText, parsePidRows } from './productImageAssetsModel';

type ProductRecord = { pid: string; importDate: string; files: string[]; relativePath: string };
type GalleryItem = { pid: string; title?: string; description?: string; coverUrl?: string };
type ProductImageAsset = { id: string; pid: string; name: string; importDate: string; mimeType: string; thumbnailUrl?: string };
type ProductFolder = ProductRecord & { images?: ProductImageAsset[]; coverUrl?: string; coverAssetId?: string };

type ProductImagesPayload = {
  success?: boolean;
  data?: { gallery?: GalleryItem[]; imported?: ProductRecord[]; folders?: ProductFolder[]; folder?: ProductFolder };
  error?: string;
  detail?: string;
};

/**
 * Shared PID product-image library.
 *
 * The asset page deliberately loads only the local index on mount. 8765 is
 * queried from the dedicated search dialog so opening an account never
 * performs a remote gallery request.
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
  const [folderImages, setFolderImages] = useState<ProductImageAsset[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pageLoading, setPageLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');

  const endpoint = `/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images`;

  const loadLocal = useCallback(async () => {
    setPageLoading(true);
    setMessage('');
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const payload = await response.json() as ProductImagesPayload;
      if (!response.ok || !payload.success) throw new Error(formatProviderErrorWithDetail(payload.error, payload.detail) || '商品图片服务暂不可用');
      setImported(payload.data?.imported ?? []);
      setFolders(payload.data?.folders ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '商品图片加载失败');
    } finally {
      setPageLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);

  const importedPids = useMemo(() => new Set(imported.map((item) => item.pid)), [imported]);

  async function readPidFile(file: File): Promise<string[]> {
    const extension = file.name.toLowerCase().split('.').pop();
    if (extension === 'txt') {
      return parsePidListText(await file.text());
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
    setSearching(true);
    setMessage('');
    try {
      const responses: PromiseSettledResult<GalleryItem[]>[] = [];
      for (let index = 0; index < pids.length; index += 8) {
        const batch = await Promise.allSettled(pids.slice(index, index + 8).map(async (pid) => {
          const response = await fetch(`${endpoint}?source=8765&query=${encodeURIComponent(pid)}`, { cache: 'no-store' });
          const payload = await response.json() as ProductImagesPayload;
          if (!response.ok || !payload.success) throw new Error(formatProviderErrorWithDetail(payload.error, payload.detail) || '8765 图库搜索失败');
          return payload.data?.gallery ?? [];
        }));
        responses.push(...batch);
      }
      const fulfilled = responses.filter((result): result is PromiseFulfilledResult<GalleryItem[]> => result.status === 'fulfilled');
      const rejected = responses.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const merged = normalizeProductGalleryItems(fulfilled.flatMap((result) => result.value));
      setGallery(merged);
      // An unknown PID comes back as HTTP 200 with no items, which means “not in
      // the gallery” rather than a broken service; only rejected requests are
      // reported as failures.
      if (rejected.length) {
        const reason = rejected[0].reason;
        const detail = reason instanceof Error ? reason.message : String(reason ?? '');
        setMessage(merged.length
          ? `已展示 ${merged.length} 个结果；${rejected.length} 个 PID 查询失败（${detail}）`
          : `8765 图库查询失败：${detail}`);
      } else if (!merged.length) {
        setMessage(`8765 图库里没有找到这 ${pids.length} 个 PID，请确认 PID 是否正确`);
      }
    } catch (error) {
      setGallery([]);
      setMessage(error instanceof Error ? error.message : '8765 图库搜索失败');
    } finally {
      setSearching(false);
    }
  }

  async function importSelected() {
    if (readOnly || !selected.length) return;
    setImporting(true);
    setMessage('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pids: selected }),
      });
      const payload = await response.json() as ProductImagesPayload;
      if (!response.ok || !payload.success) throw new Error(formatProviderErrorWithDetail(payload.error, payload.detail) || '商品图片导入失败');
      setSelected([]);
      setGallery([]);
      setSubmittedQuery('');
      await loadLocal();
      setSearchOpen(false);
      setMessage('导入完成');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '商品图片导入失败');
    } finally {
      setImporting(false);
    }
  }

  // The folder list is served without images; the detail request loads them
  // only when someone actually opens the folder.
  function openFolderDetail(folder: ProductFolder) {
    setOpenFolder(folder);
    setFolderImages(folder.images ?? []);
    if (folder.images?.length) return;
    setFolderLoading(true);
    fetch(`${endpoint}?pid=${encodeURIComponent(folder.pid)}`, { cache: 'no-store' })
      .then((response) => response.json() as Promise<ProductImagesPayload>)
      .then((payload) => { if (payload.success && payload.data?.folder) setFolderImages(payload.data.folder.images ?? []); })
      .catch(() => setFolderImages([]))
      .finally(() => setFolderLoading(false));
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
          <p className="product-image-library-hint">只展示已导入到本地的 PID 文件夹；需要新商品图时再搜索 8765。</p>
        </div>
        <button type="button" className="primary-button" onClick={openSearchDialog}>
          <Search size={14} /> 搜索 PID
        </button>
      </div>

      {message && <p role="status" className="product-image-message"><Check size={14} />{message}</p>}
      {pageLoading && !searchOpen && <div className="asset-empty"><Loader2 size={16} className="spin" />正在加载本地商品图…</div>}

      <div className="product-imported-list">
        {folders.length ? folders.map((item) => (
          <button type="button" className="product-folder-card" key={`${item.importDate}-${item.pid}`} onClick={() => openFolderDetail(item)}>
            <span className="product-folder-card-cover">
              {item.coverUrl ? <img src={item.coverUrl} alt={`${item.pid} 封面`} loading="lazy" /> : <ImageIcon size={22} />}
            </span>
            <span className="product-folder-card-meta">
              <strong>{item.pid}</strong>
              <small>{item.importDate} · {item.files.length} 张图片</small>
            </span>
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
          <section className="modal-card product-pid-search-modal large-modal" role="dialog" aria-modal="true" aria-labelledby="product-pid-search-title">
            <div className="panel-header">
              <div>
                <h2 id="product-pid-search-title" className="panel-title">搜索 8765 PID</h2>
                <div className="panel-meta">搜索结果按 PID 文件夹展示，勾选后可批量导入到本地商品图。</div>
              </div>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setSearchOpen(false)}><X size={15} /></button>
            </div>
            <form className="product-image-search product-pid-search-form" role="search" onSubmit={searchGallery}>
              <label className="sr-only" htmlFor="product-pid-query">搜索 8765 PID</label>
              <input
                id="product-pid-query"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (pidFilePids.length) {
                    setPidFilePids([]);
                    setPidFileName('');
                  }
                }}
                placeholder="输入 PID"
                autoFocus
              />
              <button type="submit" className="ghost-button" disabled={searching}><Search size={14} /> 搜索</button>
            </form>
            <label className="product-pid-file-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void handlePidFile(event.dataTransfer.files?.[0]); }}>
              <input
                type="file"
                accept=".xlsx,.xls,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/plain"
                onChange={(event) => { void handlePidFile(event.target.files?.[0]); event.currentTarget.value = ''; }}
              />
              <span><Download size={15} />拖入或选择 PID 文件</span>
              <small>支持 Excel 第一列 PID，或 TXT 每行一个 PID{pidFileName ? ` · ${pidFileName}（${pidFilePids.length} 个）` : ''}</small>
            </label>
            {message && <p role="status" className="product-image-message">{message}</p>}
            {searching && <div className="asset-empty"><Loader2 size={16} className="spin" />正在搜索 8765…</div>}
            {!searching && submittedQuery && !gallery.length && <div className="asset-empty"><ImageIcon size={18} />没有匹配的 PID。</div>}
            {!searching && gallery.length > 0 && (
              <>
                <div className="product-pid-search-actions">
                  <span>找到 {gallery.length} 个 PID</span>
                  {!readOnly && <button type="button" className="primary-button" onClick={() => void importSelected()} disabled={!selected.length || importing}>{importing ? <Loader2 size={14} className="spin" /> : <Download size={14} />} 导入选中 ({selected.length})</button>}
                </div>
                <div className="product-gallery-grid">
                  {gallery.map((item) => {
                    const alreadyImported = importedPids.has(item.pid);
                    const checked = selected.includes(item.pid);
                    return (
                      <article className={`product-gallery-card ${alreadyImported ? 'imported' : ''}`} key={item.pid}>
                        <label>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={readOnly || alreadyImported}
                            onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, item.pid])] : current.filter((pid) => pid !== item.pid))}
                          />
                          <strong>{item.pid}</strong>
                          {alreadyImported && <small>已导入</small>}
                        </label>
                        {item.coverUrl ? <img src={item.coverUrl} alt={`${item.pid} 商品封面`} /> : <div className="product-cover-placeholder"><ImageIcon size={24} /></div>}
                        <span>{item.pid}</span>
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
          <section className="modal-card product-folder-modal large-modal" role="dialog" aria-modal="true" aria-labelledby="product-folder-title">
            <div className="panel-header">
              <div>
                <h2 id="product-folder-title" className="panel-title">PID {openFolder.pid} 图片</h2>
                <div className="panel-meta">{folderLoading ? '正在加载文件夹图片…' : `${folderImages.length} 张图片，可在生产界面继续选择。`}</div>
              </div>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setOpenFolder(null)}><X size={15} /></button>
            </div>
            <div className="product-folder-grid">
              {folderImages.map((asset) => (
                <figure key={asset.id}>
                  <img src={asset.thumbnailUrl || `/api/workspace/product-images/preview?assetId=${encodeURIComponent(asset.id)}&thumbnail=1`} alt={asset.name} loading="lazy" decoding="async" />
                  <figcaption>{asset.name}</figcaption>
                </figure>
              ))}
              {folderLoading && <div className="asset-empty"><Loader2 size={16} className="spin" />正在加载文件夹图片…</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
