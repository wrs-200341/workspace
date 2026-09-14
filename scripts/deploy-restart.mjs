/**
 * Build, swap .next, and restart production through start-production.mjs.
 *
 * After the task store is migrated to SQLite, deployment must never bypass the
 * provider worker supervisor or silently roll back to an older JSON-task build.
 */
import { existsSync, openSync, closeSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEnvConfig } = nextEnv;
loadEnvConfig(root);
const PORT = 3000;
const HOST = '127.0.0.1';
const LOG_FILE = join(root, 'server.log');
const dataRoot = resolve(process.env.WORKSPACE_DATA_ROOT || join(root, 'data'));
const databaseFile = join(dataRoot, 'providers', 'tasks.sqlite');

function probe(port = PORT, host = HOST, timeout = 1500) {
  return new Promise((done) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate, { timeoutMs, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function sqliteMigrated() {
  if (!existsSync(databaseFile)) return false;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT value FROM task_store_meta WHERE key='imported'").get());
  } finally {
    db.close();
  }
}

function listenerProcesses(port = PORT) {
  const result = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `$items=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; $items | ForEach-Object { $p=Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)"; [pscustomobject]@{pid=$_.OwningProcess; commandLine=$p.CommandLine} } | ConvertTo-Json -Compress`,
  ], { capture: true });
  const text = (result.stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({ pid: Number(row.pid), commandLine: typeof row.commandLine === 'string' ? row.commandLine : '' }))
      .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  } catch {
    return [];
  }
}

function isLegacyDirectNext(commandLine) {
  const command = commandLine.toLowerCase();
  return command.includes('next') && command.includes(' start') && !command.includes('start-production.mjs');
}

const step = (message) => console.log(`\n[deploy] ${message}`);

const migrated = sqliteMigrated();
const listenersBeforeBuild = listenerProcesses();
if (!migrated) {
  const legacy = listenersBeforeBuild.find((item) => isLegacyDirectNext(item.commandLine));
  if (legacy) {
    console.error(`[deploy] refusing to stop legacy JSON Next PID ${legacy.pid} before SQLite migration/drain has completed.`);
    process.exit(1);
  }
  console.error('[deploy] task SQLite database is not migrated; run npm run tasks:migrate before production deploy.');
  process.exit(1);
}

step('building (isolated while the live server keeps serving)…');
const build = run(process.execPath, [join(root, 'scripts', 'safe-next-build.mjs')]);
if (build.status !== 0) {
  console.error('[deploy] build failed; the running server was left untouched.');
  process.exit(1);
}

const verifyDir = join(root, '.next-verify');
const liveDir = join(root, '.next');
const backupDir = join(root, '.next-previous');
const builtIsolated = existsSync(verifyDir);

if (builtIsolated && !existsSync(join(verifyDir, 'BUILD_ID'))) {
  console.error('[deploy] isolated build is missing BUILD_ID; refusing to swap.');
  process.exit(1);
}

step('gracefully restarting provider worker while web keeps serving…');
const workerRestart = run(process.execPath, [join(root, 'scripts', 'start-production.mjs'), '--restart-worker', '--no-web']);
if (workerRestart.status !== 0) {
  console.error('[deploy] provider worker restart failed; the running web server was left untouched.');
  process.exit(1);
}

const pids = listenerProcesses().map((item) => item.pid);
if (pids.length) {
  step(`stopping server (pid ${pids.join(', ')})…`);
  for (const pid of pids) run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
  await waitFor(async () => !(await probe()), { timeoutMs: 20_000, label: 'port 3000 to free up' });
} else {
  step('no live server found; starting fresh.');
}

if (builtIsolated) {
  step('swapping in the new build…');
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
  if (existsSync(liveDir)) renameSync(liveDir, backupDir);
  renameSync(verifyDir, liveDir);
}

step('starting production wrapper…');
const log = openSync(LOG_FILE, 'a');
const child = spawn(process.execPath, [join(root, 'scripts', 'start-production.mjs')], {
  cwd: root,
  detached: true,
  stdio: ['ignore', log, log],
  windowsHide: true,
  env: { ...process.env, WORKSPACE_NEXT_DIST_DIR: '' },
});
closeSync(log);
child.unref();

try {
  await waitFor(() => probe(), { timeoutMs: 90_000, label: 'server to accept connections' });
} catch (error) {
  console.error(`[deploy] ${error.message}`);
  console.error('[deploy] not rolling back automatically because SQLite may already be accepting provider jobs. Restore manually only after verifying task-store compatibility.');
  process.exit(1);
}

step(`server is live on http://${HOST}:${PORT} (log: ${LOG_FILE})`);
