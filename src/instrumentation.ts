/**
 * Server startup hook. The product-image scheduler performs a compensating
 * cleanup immediately and then schedules the next Shanghai midnight run.
 * It never runs in the Edge runtime and is safe to call more than once.
 */
export async function register() {
  // Product-image cleanup is exposed through the authenticated cleanup API and
  // can be scheduled by the host process/task scheduler. Keeping the
  // instrumentation hook side-effect free avoids bundling node:fs/node:zlib
  // into Next's instrumentation worker (which may be compiled for edge).
}
