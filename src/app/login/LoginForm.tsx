'use client';

import { FormEvent, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const response = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ username, password }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error === 'invalid_credentials' ? '账号或密码不正确' : payload.error === 'auth_not_initialized' ? '账号尚未初始化，请先运行 setup-auth.ps1' : '登录失败');
      router.replace(safeNextPath(search.get('next'))); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); }
    finally { setLoading(false); }
  }
  return <main className="auth-page"><div className="auth-card"><div className="brand"><span className="brand-mark">W</span><span>workspace <span style={{ color:'#9aa3b2', fontWeight:400 }}>/ 账号登录</span></span></div><h1>登录放映厅</h1><p className="subtitle">请选择你的账号级别进入 workspace。</p><form onSubmit={submit} className="auth-form"><label>账号<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="admin / workspace / operator" /></label><label>密码<input autoComplete="current-password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" /></label>{error && <div role="alert" className="auth-error">{error}</div>}<button className="primary-button" disabled={loading}>{loading ? '登录中…' : '登录 workspace'}</button></form><div className="auth-hint">管理员管理账号；工作台账号执行生产；运营账号负责看板与复盘。</div></div></main>;
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
