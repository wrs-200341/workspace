'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import type { AnchorHTMLAttributes } from 'react';

const HOVER_DELAY_MS = 120;
const MIN_REQUEST_INTERVAL_MS = 500;
const RECENT_TTL_MS = 30_000;
const MAX_RECENT_ROUTES = 12;

/** Only tracks route names; Next owns the authenticated payload cache and network queue. */
export function createIntentPrefetcher(prefetch: (href: string) => void, enabled: () => boolean = () => true) {
  const recent = new Map<string, number>();
  let pending: { href: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let nextRequestAt = 0;

  function cancel(href?: string) {
    if (!pending || (href !== undefined && pending.href !== href)) return;
    clearTimeout(pending.timer);
    pending = undefined;
  }

  function schedule(href: string, immediate = false) {
    cancel();
    if (!enabled() || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return;
    const now = Date.now();
    for (const [route, expiresAt] of recent) if (expiresAt <= now) recent.delete(route);
    if (recent.has(href)) return;
    const delay = Math.max(immediate ? 0 : HOVER_DELAY_MS, nextRequestAt - now);
    pending = {
      href,
      timer: setTimeout(() => {
        pending = undefined;
        if (!enabled()) return;
        try {
          prefetch(href);
          nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
          recent.set(href, Date.now() + RECENT_TTL_MS);
          while (recent.size > MAX_RECENT_ROUTES) recent.delete(recent.keys().next().value!);
        } catch {
          // Navigation still works if the router declines a speculative request.
        }
      }, delay),
    };
  }

  function reset() {
    cancel();
    recent.clear();
    nextRequestAt = 0;
  }

  return { schedule, cancel, reset };
}

function connectionAllowsPrefetch() {
  if (typeof navigator === 'undefined' || document.visibilityState === 'hidden') return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !connection?.saveData && connection?.effectiveType !== 'slow-2g' && connection?.effectiveType !== '2g';
}

type IntentLinkProps = Pick<AnchorHTMLAttributes<HTMLAnchorElement>, 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'> & { prefetch: false };

export function useIntentPrefetch(scope: string) {
  const router = useRouter();
  const scheduler = useMemo(() => createIntentPrefetcher((href) => router.prefetch(href), () => Boolean(scope) && connectionAllowsPrefetch()), [router, scope]);
  useEffect(() => () => scheduler.reset(), [scheduler]);

  function intentLinkProps(href: string): IntentLinkProps {
    return {
      prefetch: false,
      onPointerEnter: (event) => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') scheduler.schedule(href); },
      onPointerLeave: () => scheduler.cancel(href),
      onFocus: () => scheduler.schedule(href, true),
      onBlur: () => scheduler.cancel(href),
    };
  }

  return { intentLinkProps, cancelPrefetch: scheduler.reset };
}
