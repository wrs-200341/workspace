import { Loader2 } from 'lucide-react';

export default function Loading() {
  return (
    <div className="page-loading-backdrop" role="status" aria-live="polite">
      <div className="page-loading-spinner">
        <Loader2 size={28} className="spin" />
        <span>正在加载页面…</span>
      </div>
    </div>
  );
}
