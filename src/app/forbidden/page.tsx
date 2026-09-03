import Link from 'next/link';
export default function ForbiddenPage() { return <main className="auth-page"><div className="auth-card"><div className="eyebrow">403 / Forbidden</div><h1>没有访问权限</h1><p className="subtitle">当前账号级别不能访问这个页面。</p><Link className="primary-button" href="/">返回放映厅</Link></div></main>; }
