import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());
process.env.WORKSPACE_PROVIDER_WORKER = 'true';

async function main(): Promise<void> {
  const { DurableProviderWorker } = await import('../src/lib/providers/durableWorker');
  const worker = new DurableProviderWorker();
  let stopRequested = false;
  const requestStop = () => { stopRequested = true; };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  process.on('message', (message) => { if (message === 'drain') requestStop(); });
  worker.start();
  console.log(`Provider worker started (${worker.workerId}).`);
  try {
    do {
      await worker.tick();
      if (process.argv.includes('--once')) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stopRequested && !worker.isStopping);
  } finally {
    console.log('Provider worker draining in-flight work.');
    await worker.drain();
    console.log('Provider worker stopped.');
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'provider_worker_failed'); process.exitCode = 1; }).finally(() => {
  if (process.connected) process.disconnect();
});
