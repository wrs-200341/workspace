'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { ROLE_LABELS, type AuthUser, type Role } from '@/lib/auth/policy';

type UserForm = {
  id?: string;
  username: string;
  displayName: string;
  role: Role;
  password: string;
};

const emptyForm: UserForm = { username: '', displayName: '', role: 'operator', password: '' };

export function AccountControlPage() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    const response = await fetch('/api/auth/users', { cache: 'no-store' });
    const body = await response.json().catch(() => null) as { success?: boolean; data?: AuthUser[]; error?: string } | null;
    if (response.ok && body?.success) setUsers(body.data ?? []);
    else setError(body?.error || '无法读取账号列表');
  }

  useEffect(() => { void load(); }, []);

  function startCreate() {
    setError('');
    setForm({ ...emptyForm });
  }

  function startEdit(user: AuthUser) {
    setError('');
    setForm({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, password: '' });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const editing = Boolean(form.id);
      const endpoint = editing ? `/api/auth/users/${encodeURIComponent(form.id!)}` : '/api/auth/users';
      const body = editing
        ? { displayName: form.displayName, role: form.role, ...(form.password ? { password: form.password } : {}) }
        : form;
      const response = await fetch(endpoint, { method: editing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.error || '保存账号失败');
      setForm({ ...emptyForm });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存账号失败');
    } finally {
      setLoading(false);
    }
  }

  async function remove(user: AuthUser) {
    if (!window.confirm(`确定删除账号“${user.displayName}”（${user.username}）吗？`)) return;
    setError('');
    const response = await fetch(`/api/auth/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
    if (!response.ok || !payload?.success) { setError(payload?.error || '删除账号失败'); return; }
    if (form.id === user.id) setForm({ ...emptyForm });
    await load();
  }

  return <>
    <div className="page-heading">
      <div><div className="eyebrow">System / account control</div><h1>账号控制</h1><p className="subtitle">管理员可以新增、查看、编辑和删除三种级别的账号，并修改显示名称、权限级别和密码。</p></div>
      <button className="primary-button" type="button" onClick={startCreate}><Plus size={14} /> 新增账号</button>
    </div>
    <div className="section-grid content-grid">
      <section className="panel">
        <div className="panel-header"><div><h2 className="panel-title">{form.id ? '编辑账号' : '创建账号'}</h2><div className="panel-meta">密码只保存为 scrypt 哈希，原始密码不会回显。</div></div>{form.id && <button className="icon-button" type="button" aria-label="取消编辑" onClick={() => setForm({ ...emptyForm })}><X size={15} /></button>}</div>
        <form className="production-form" onSubmit={submit}>
          <label>登录名<input className="select" value={form.username} disabled={Boolean(form.id)} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} required={!form.id} /></label>
          <label>显示名称<input className="select" value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} required /></label>
          <label>账号权限<select className="select" value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as Role }))}><option value="admin">管理员</option><option value="workspace">工作台账号</option><option value="operator">运营账号</option></select></label>
          <label>{form.id ? '新密码（留空则不修改）' : '初始密码'}<input className="select" type="password" minLength={8} value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} required={!form.id} /></label>
          {error && <div role="alert" className="auth-error">{error}</div>}
          <button className="primary-button" type="submit" disabled={loading}>{loading ? '保存中…' : form.id ? '保存修改' : '创建账号'}</button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-header"><div><h2 className="panel-title">现有账号</h2><div className="panel-meta">共 {users.length} 个账号；密码不会在列表中显示。</div></div></div>
        <div className="ranking">{users.map((user) => <div className="rank-row" key={user.id}><div className="notice-icon"><span style={{ fontSize: 12, fontWeight: 700 }}>{user.username.slice(0, 1).toUpperCase()}</span></div><div style={{ flex: 1 }}><div className="rank-name">{user.displayName}</div><div className="rank-sub">{user.username} · {ROLE_LABELS[user.role]}</div></div><span className="status"><span className="dot" />{user.active ? '启用' : '停用'}</span><button className="icon-button" type="button" aria-label={`编辑 ${user.username}`} onClick={() => startEdit(user)}><Pencil size={14} /></button><button className="icon-button" type="button" aria-label={`删除 ${user.username}`} onClick={() => void remove(user)}><Trash2 size={14} /></button></div>)}</div>
      </section>
    </div>
  </>;
}
