import { monitorEventLoopDelay } from 'node:perf_hooks';

const runtime = globalThis as typeof globalThis & { __workspaceLagMonitor?: ReturnType<typeof setInterval> };

export function startRuntimePerformanceMonitor(): void {
  if (process.env.NODE_ENV !== 'production' || runtime.__workspaceLagMonitor) return;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const maxMs = Math.round(histogram.max / 1e6);
    if (maxMs >= 250) console.warn(JSON.stringify({ event: 'web_event_loop_delay', maxMs,
      p99Ms: Math.round(histogram.percentile(99) / 1e6), rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
    histogram.reset();
  }, 30_000);
  timer.unref();
  runtime.__workspaceLagMonitor = timer;
}
