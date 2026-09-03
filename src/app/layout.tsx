import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'workspace · 放映厅 · 3000', description: 'TikTok 机构账号数据看板' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
