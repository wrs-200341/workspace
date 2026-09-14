/**
 * Lightweight web-process monitoring. Production and media cleanup run in
 * the independently supervised provider worker.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startRuntimePerformanceMonitor } = await import('./lib/runtimePerformance');
    startRuntimePerformanceMonitor();
  }
}
