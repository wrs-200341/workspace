'use client';

import { BarChart3, Clapperboard, LayoutDashboard, LogOut, Menu, Settings2, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { hasPermission, type AuthUser } from '@/lib/auth/policy';

const nav = [
  { label: '放映厅', href: '/', icon: LayoutDashboard },
  { label: '工作台', href: '/workspace', icon: Clapperboard },
  { label: '下游看板', href: '/downstream', icon: BarChart3 },
  { label: '账号资产', href: '/accounts', icon: Users },
];

export function AppShell({ children, user }: { children: React.ReactNode; user?: AuthUser | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [todayLabel, setTodayLabel] = useState('');
  useEffect(() => {
    setTodayLabel(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(new Date()));
  }, []);
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><button className="mobile-menu" aria-label={open ? '关闭导航' : '打开导航'} onClick={() => setOpen(!open)}>{open ? <X size={19} /> : <Menu size={19} />}</button><span className="brand-mark">W</span><span>workspace <span style={{ color:'#9aa3b2', fontWeight:400 }}>/ 放映厅 3000</span></span></div>
      <div className="top-actions"><span className="service-pill"><span className="dot" /> 数据源待同步 · 9001</span>{user ? <><span>{user.displayName}</span><span className="tag">{user.role === 'admin' ? '管理员' : user.role === 'workspace' ? '工作台账号' : '运营账号'}</span><button className="icon-button" aria-label="退出登录" onClick={async () => { await fetch('/api/auth/logout', { method:'POST' }); router.replace('/login'); router.refresh(); }}><LogOut size={14} /></button></> : <a href="/login" className="panel-meta" style={{ color:'#1e40af', textDecoration:'none' }}>登录</a>}</div>
    </header>
    <div className="layout">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="nav-label">Workspace</div>
        <nav aria-label="主导航">{user && nav.filter(item => hasPermission(user.role, item.href === '/' ? 'dashboard' : item.href === '/workspace' ? 'workspace' : item.href === '/downstream' ? 'downstream' : 'assets')).map(({ label, href, icon: Icon }) => <a key={href} href={href} className={`nav-item ${pathname === href || (href !== '/' && pathname.startsWith(href)) ? 'active' : ''}`} onClick={() => setOpen(false)}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></a>)}</nav>
        <div className="nav-label" style={{ marginTop:28 }}>System</div>
        {user?.role === 'admin' && <a className="nav-item" href="/admin/accounts"><Settings2 size={17} strokeWidth={1.8} /><span>账号控制</span></a>}
        <button className="nav-item"><Settings2 size={17} strokeWidth={1.8} /><span>同步与设置</span></button>
        <div className="nav-label" style={{ marginTop:28 }}>Today</div>
        <div style={{ margin:'12px', padding:'12px', background:'#f7f9fc', border:'1px solid #edf0f4', fontSize:12, color:'#6d778b', lineHeight:1.6 }}>数据按北京时间聚合<br /><strong style={{ color:'#172033' }}>{todayLabel || '—'}</strong></div>
      </aside>
      <main className="main">{children}</main>
    </div>
  </div>;
}
