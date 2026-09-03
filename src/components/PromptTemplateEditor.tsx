'use client';

import { FileText, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PromptAssetCategory, WorkspaceAsset } from '@/lib/workspace/assetStore';

type Props = { accountId: string; initialAssets?: WorkspaceAsset[]; initialCategory?: PromptAssetCategory; onSaved?: () => void | Promise<void> };

export function PromptTemplateEditor({ accountId, initialAssets = [], initialCategory = 'video', onSaved }: Props) {
  const [assets, setAssets] = useState<WorkspaceAsset[]>(initialAssets.filter((asset) => asset.kind === 'prompt'));
  const [category, setCategory] = useState<PromptAssetCategory>(initialCategory);
  const [selectedId, setSelectedId] = useState<string | null>(initialAssets.find((asset) => asset.kind === 'prompt' && (asset.category ?? 'video') === initialCategory)?.id ?? null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const visibleAssets = useMemo(() => assets.filter((asset) => (asset.category ?? 'video') === category), [assets, category]);
  const selected = useMemo(() => visibleAssets.find((asset) => asset.id === selectedId) ?? null, [visibleAssets, selectedId]);

  useEffect(() => {
    setAssets(initialAssets.filter((asset) => asset.kind === 'prompt'));
  }, [initialAssets]);

  useEffect(() => {
    setCategory(initialCategory);
  }, [initialCategory]);

  useEffect(() => {
    if (!selected) setSelectedId(visibleAssets[0]?.id ?? null);
  }, [selected, visibleAssets]);

  useEffect(() => {
    if (!selected) {
      setName('');
      setContent('');
      return;
    }
    setName(selected.name);
    setContent(selected.content ?? '');
  }, [selected]);

  function startNew() {
    setSelectedId(null);
    setName(category === 'image' ? '新的生图提示词模板' : '新的生视频提示词模板');
    setContent('');
    setMessage('');
  }

  async function save() {
    if (!name.trim() || !content.trim()) { setMessage('请填写模板名称和内容'); return; }
    setSaving(true); setMessage('');
    try {
      const editing = Boolean(selectedId);
      const endpoint = editing
        ? `/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(selectedId!)}`
        : `/api/workspace/accounts/${encodeURIComponent(accountId)}/files`;
      const response = await fetch(endpoint, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editing ? { name, content, category } : { kind: 'prompt', name, content, category }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: WorkspaceAsset; error?: string } | null;
      if (!response.ok || !payload?.success || !payload.data) throw new Error(payload?.error || '保存失败');
      const next = payload.data;
      setAssets((current) => editing ? current.map((asset) => asset.id === next.id ? next : asset) : [...current, next]);
      setSelectedId(next.id);
      setName(next.name);
      setContent(next.content ?? '');
      setMessage(editing ? '模板已更新' : '模板已保存');
      await onSaved?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!selected || deleting || !window.confirm(`确定删除提示词模板“${selected.name}”吗？此操作不可撤销。`)) return;
    setDeleting(true); setMessage('');
    try {
      const response = await fetch(`/api/workspace/accounts/${encodeURIComponent(accountId)}/files/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '删除失败');
      const remaining = assets.filter((asset) => asset.id !== selected.id);
      setAssets(remaining);
      const next = remaining[0] ?? null;
      setSelectedId(next?.id ?? null);
      setName(next?.name ?? '新提示词模板');
      setContent(next?.content ?? '');
      setMessage('模板已删除');
      await onSaved?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : '删除失败'); }
    finally { setDeleting(false); }
  }

  return <div className="prompt-template-editor-layout">
    <aside className="prompt-template-list" aria-label="已保存提示词模板">
      <div className="prompt-template-list-header"><span>已保存模板</span><button type="button" className="prompt-template-new" onClick={startNew}><Plus size={14} /> 新建</button></div>
      <div className="prompt-template-category-tabs" role="tablist" aria-label="提示词模板类型"><button type="button" role="tab" aria-selected={category === 'image'} className={category === 'image' ? 'active' : ''} onClick={() => { setCategory('image'); setMessage(''); }}>生图模板</button><button type="button" role="tab" aria-selected={category === 'video'} className={category === 'video' ? 'active' : ''} onClick={() => { setCategory('video'); setMessage(''); }}>生视频模板</button></div>
      {visibleAssets.length ? visibleAssets.map((asset) => <button type="button" key={asset.id} className={`prompt-template-list-item ${asset.id === selectedId ? 'active' : ''}`} onClick={() => { setSelectedId(asset.id); setMessage(''); }}><FileText size={15} /><span>{asset.name}</span></button>) : <div className="prompt-template-list-empty">暂无模板</div>}
    </aside>
    <section className="prompt-template-editor-pane" aria-label={selected ? `编辑模板 ${selected.name}` : '新建提示词模板'}>
      <div className="prompt-template-editor-heading"><div><div className="eyebrow">{selected ? 'EDIT TEMPLATE' : 'NEW TEMPLATE'}</div><h3>{selected ? '编辑提示词模板' : '新建提示词模板'}</h3></div><span>{content.length.toLocaleString()} / 30,000</span></div>
      <label>模板名称<input className="select" value={name} onChange={(event) => setName(event.target.value)} placeholder="模板名称" maxLength={120} /></label>
      <label>模板内容<textarea className="select" rows={14} value={content} onChange={(event) => setContent(event.target.value)} placeholder="写入可复用的生图 / 生视频提示词…" maxLength={30000} /></label>
      <div className="prompt-template-editor-footer"><span role="status">{message}</span><div className="prompt-template-editor-actions">{selected && <button className="danger-button" type="button" onClick={remove} disabled={saving || deleting}><Trash2 size={14} /> {deleting ? '删除中…' : '删除模板'}</button>}<button className="primary-button" type="button" onClick={save} disabled={saving || deleting}><Save size={14} /> {saving ? '保存中…' : selected ? '保存修改' : '保存模板'}</button></div></div>
    </section>
  </div>;
}
