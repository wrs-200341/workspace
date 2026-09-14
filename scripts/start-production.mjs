import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import nextEnv from '@next/env';
import {
  processAlive,
  providerControlPaths,
  readSupervisorState,
  supervisorStateMatchesRuntime,
  waitUntil,
  writeDrainRequest,
} from './provider-worker-control.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supervisorScript = join(root, 'scripts', 'provider-worker-supervisor.mjs');
const { loadEnvConfig } = nextEnv;
loadEnvConfig(root);

const args = new Set(process.argv.slice(2));
const restartWorker = args.has('--restart-worker') || process.env.WORKSPACE_RESTART_PROVIDER_WORKER === '1';
const noWeb = args.has('--no-web');
const dataRoot = resolve(process.env.WORKSPACE_DATA_ROOT || join(root, 'data'));
const paths = providerControlPaths(root, dataRoot);
const databaseFile = join(dataRoot, 'providers', 'tasks.sqlite');

function ensureMigratedDatabase() {
  if (!existsSync(databaseFile)) throw new Error('Run npm run tasks:migrate before starting production.');
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    if (!db.prepare("SELECT value FROM task_store_meta WHERE key='imported'").get()) throw new Error('Task database migration is incomplete.');
  } finally {
    db.close();
  }
}

function readWorkerLease() {
  if (!existsSync(databaseFile)) return undefined;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT worker_id,pid,expires_at FROM provider_worker_lease WHERE singleton=1').get();
    if (!row) return undefined;
    const pid = Number(row.pid);
    const expiresAt = Number(row.expires_at);
    const workerId = typeof row.worker_id === 'string' ? row.worker_id : '';
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(expiresAt) || !workerId) return undefined;
    return { workerId, pid, expiresAt };
  } finally {
    db.close();
  }
}

function leaseHealthy(lease = readWorkerLease()) {
  if (!lease) return false;
  if (lease.expiresAt <= Date.now() + 2500) return false;
  if (!processAlive(lease.pid)) return false;
  return lease.workerId.startsWith(`${lease.pid}:`);
}

function supervisorHealthy() {
  const state = readSupervisorState(paths);
  if (!supervisorStateMatchesRuntime(state, { root, script: supervisorScript })) return false;
  const lease = readWorkerLease();
  return Boolean(state?.childPid && lease?.pid === state.childPid && leaseHealthy(lease));
}

function startSupervisor() {
  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  const output = openSync(join(logDir, 'provider-worker.out.log'), 'a');
  const error = openSync(join(logDir, 'provider-worker.err.log'), 'a');
  try {
    const worker = spawn(process.execPath, [supervisorScript], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output, error],
      env: { ...process.env },
    });
    if (!worker.pid) throw new Error('provider_worker_start_failed');
    worker.unref();
    return worker.pid;
  } finally {
    closeSync(output);
    closeSync(error);
  }
}

async function drainSupervisor(state, reason) {
  if (!state || !processAlive(state.pid)) return;
  writeDrainRequest(paths, state, reason);
  console.log(`Waiting for provider worker supervisor ${state.pid} to drain (${reason}). This can take several minutes if an upstream request is in flight.`);
  const stopped = await waitUntil(() => !processAlive(state.pid), { timeoutMs: 15 * 60_000, intervalMs: 1000 });
  if (!stopped) throw new Error(`provider_worker_drain_timeout:${state.pid}`);
}

async function ensureProviderWorker() {
  let state = readSupervisorState(paths);
  if (restartWorker && state && supervisorStateMatchesRuntime(state, { root, script: supervisorScript })) {
    console.log(`Draining provider worker supervisor ${state.pid} for deployment restart.`);
    await drainSupervisor(state, 'deployment-restart');
    state = readSupervisorState(paths);
  }

  if (!restartWorker && supervisorStateMatchesRuntime(state, { root, script: supervisorScript })) {
    const healthy = await waitUntil(() => supervisorHealthy(), { timeoutMs: 8_000, intervalMs: 500 });
    if (healthy) return readSupervisorState(paths)?.pid ?? state.pid;
    console.error(`Provider worker supervisor ${state.pid} is alive but has no healthy lease; draining and replacing it.`);
    await drainSupervisor(state, 'unhealthy-lease');
  }

  const pid = startSupervisor();
  const healthy = await waitUntil(() => supervisorHealthy(), { timeoutMs: 30_000, intervalMs: 500 });
  if (!healthy) {
    const latest = readSupervisorState(paths);
    if (latest) await drainSupervisor(latest, 'startup-health-timeout');
    throw new Error('provider_worker_health_timeout');
  }
  return readSupervisorState(paths)?.pid ?? pid;
}

function powershell(command) {
  if (process.platform !== 'win32') return '';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function detectPort3000Owner() {
  const output = powershell(`$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p=Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"; [pscustomobject]@{pid=$c.OwningProcess; commandLine=$p.CommandLine} | ConvertTo-Json -Compress }`);
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output);
    const pid = Number(parsed.pid);
    const commandLine = typeof parsed.commandLine === 'string' ? parsed.commandLine : '';
    return Number.isInteger(pid) && pid > 0 ? { pid, commandLine } : undefined;
  } catch {
    return undefined;
  }
}

function guardOldJsonServer() {
  const owner = detectPort3000Owner();
  if (!owner) return;
  const command = owner.commandLine.toLowerCase();
  const directNext = command.includes('next') && command.includes(' start') && !command.includes('start-production.mjs');
  if (directNext) {
    throw new Error(`Port 3000 is still owned by the legacy direct Next server PID ${owner.pid}. Stop it before starting SQLite production, otherwise tasks.json can diverge after migration.`);
  }
  throw new Error(`Port 3000 is already in use by PID ${owner.pid}. Stop it before starting production.`);
}

ensureMigratedDatabase();
if (!noWeb) guardOldJsonServer();
const workerPid = await ensureProviderWorker();
console.log(`Provider worker supervisor: ${workerPid}`);

if (noWeb) process.exit(0);

const web = spawn(process.execPath, [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-H', '0.0.0.0', '-p', '3000'], {
  cwd: root,
  windowsHide: true,
  stdio: 'inherit',
  env: { ...process.env, WORKSPACE_PROVIDER_WORKER: '', WORKSPACE_NEXT_DIST_DIR: '' },
});
web.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
web.on('exit', (code) => { process.exitCode = code ?? 1; });
// The independently supervised worker deliberately survives ordinary web restarts.
process.on('SIGINT', () => web.kill('SIGINT'));
process.on('SIGTERM', () => web.kill('SIGTERM'));
