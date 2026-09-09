/**
 * Build then hot-swap the running production server with minimal downtime.
 *
 * `safe-next-build.mjs` keeps its output in `.next-verify` whenever port 3000
 * is live, so a build alone never reaches the operators. This script performs
 * the remaining half: verify the fresh build, swap it into `.next`, restart
 * `next start`, and wait until the server answers again. Downtime is the
 * restart window only (a few seconds), and a failed build leaves the currently
 * running version untouched.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3000;
const HOST = '127.0.0.1';
const LOG_FILE = join(root, 'server.log');

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

/** PIDs owning the port, so we never guess which node process to stop. */
function listenerPids(port = PORT) {
  const result = run('powershell', [
    '-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
  ], { capture: true });
  return [...new Set((result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

const step = (message) => console.log(`\n[deploy] ${message}`);

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

const pids = listenerPids();
if (pids.length) {
  step(`stopping server (pid ${pids.join(', ')})…`);
  for (const pid of pids) run('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
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

step('starting server…');
const nextBin = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [nextBin, 'start', '-H', '0.0.0.0', '-p', String(PORT)], {
  cwd: root,
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
  env: { ...process.env, WORKSPACE_NEXT_DIST_DIR: '' },
});
child.unref();

try {
  await waitFor(() => probe(), { timeoutMs: 90_000, label: 'server to accept connections' });
} catch (error) {
  console.error(`[deploy] ${error.message}`);
  if (builtIsolated && existsSync(backupDir)) {
    console.error('[deploy] rolling back to the previous build…');
    rmSync(liveDir, { recursive: true, force: true });
    renameSync(backupDir, liveDir);
    spawn(process.execPath, [nextBin, 'start', '-H', '0.0.0.0', '-p', String(PORT)], {
      cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  }
  process.exit(1);
}

step(`server is live on http://${HOST}:${PORT} (log: ${LOG_FILE})`);
