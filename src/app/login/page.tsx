import { Suspense } from 'react';
import LoginForm from './LoginForm';

export default function LoginPage() {
  return <Suspense fallback={<main className="auth-page"><div className="auth-card">正在加载登录页…</div></main>}><LoginForm /></Suspense>;
}
