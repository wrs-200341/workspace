/**
 * Server startup hook. The product-image scheduler performs a compensating
 * cleanup immediately and then schedules the next Shanghai midnight run.
 * It never runs in the Edge runtime and is safe to call more than once.
 */
export async function register() {
  // Schedule cleanup from the long-lived Node server so the three-day PID
  // retention policy runs at every Shanghai midnight even when nobody opens
  // the asset page. The runtime guard keeps node:fs/node:zlib out of Edge.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { scheduleProductImageCleanup } = await import('./lib/workspace/productImages');
    scheduleProductImageCleanup();
  }
}
