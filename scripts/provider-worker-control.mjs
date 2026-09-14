import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const SUPERVISOR_STATE_FILE = 'worker-supervisor.json';
export const SUPERVISOR_DRAIN_FILE = 'worker-supervisor-drain.json';
export const LEGACY_SUPERVISOR_PID_FILE = 'worker-supervisor.pid';

export function providerControlPaths(root, dataRoot) {
  const resolvedRoot = resolve(root);
  const resolvedDataRoot = resolve(dataRoot);
  const providersDir = join(resolvedDataRoot, 'providers');
  return {
    root: resolvedRoot,
    dataRoot: resolvedDataRoot,
    providersDir,
    stateFile: join(providersDir, SUPERVISOR_STATE_FILE),
    drainFile: join(providersDir, SUPERVISOR_DRAIN_FILE),
    legacyPidFile: join(providersDir, LEGACY_SUPERVISOR_PID_FILE),
  };
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJsonFileAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

export function removeFileIfExists(file) {
  try {
    unlinkSync(file);
  } catch {
    // Missing files are fine; startup/drain control is best-effort.
  }
}

export function normalizeSupervisorState(value) {
  if (!value || typeof value !== 'object') return undefined;
  const record = value;
  const pid = Number(record.pid);
  const nonce = typeof record.nonce === 'string' ? record.nonce.trim() : '';
  const root = typeof record.root === 'string' ? resolve(record.root) : '';
  const script = typeof record.script === 'string' ? resolve(record.script) : '';
  if (!Number.isInteger(pid) || pid <= 0 || !nonce || !root || !script) return undefined;
  return {
    pid,
    nonce,
    root,
    script,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
    childPid: Number.isInteger(Number(record.childPid)) ? Number(record.childPid) : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  };
}

export function readSupervisorState(paths) {
  return normalizeSupervisorState(readJsonFile(paths.stateFile));
}

export function writeSupervisorState(paths, state) {
  writeJsonFileAtomic(paths.stateFile, state);
  // Keep the legacy pid file for operators, but never use it as authority.
  writeFileSync(paths.legacyPidFile, String(state.pid));
}

export function writeDrainRequest(paths, state, reason = 'restart') {
  const request = {
    pid: state.pid,
    nonce: state.nonce,
    reason,
    requestedAt: new Date().toISOString(),
  };
  writeJsonFileAtomic(paths.drainFile, request);
  return request;
}

export function readDrainRequest(paths) {
  const value = readJsonFile(paths.drainFile);
  if (!value || typeof value !== 'object') return undefined;
  const pid = Number(value.pid);
  const nonce = typeof value.nonce === 'string' ? value.nonce.trim() : '';
  if (!Number.isInteger(pid) || pid <= 0 || !nonce) return undefined;
  return {
    pid,
    nonce,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
    requestedAt: typeof value.requestedAt === 'string' ? value.requestedAt : undefined,
  };
}

export function drainRequestMatchesSupervisor(request, state) {
  return Boolean(request && state && request.pid === state.pid && request.nonce === state.nonce);
}

export function clearDrainRequest(paths, state) {
  const request = readDrainRequest(paths);
  if (!request || !state || drainRequestMatchesSupervisor(request, state)) removeFileIfExists(paths.drainFile);
}

export function supervisorStateMatchesRuntime(state, expected) {
  if (!state) return false;
  if (resolve(state.root) !== resolve(expected.root)) return false;
  if (resolve(state.script) !== resolve(expected.script)) return false;
  return processAlive(state.pid);
}

export async function waitUntil(predicate, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? 10_000));
  const intervalMs = Math.max(10, Number(options.intervalMs ?? 250));
  const startedAt = Date.now();
  let last;
  do {
    last = await predicate();
    if (last) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  } while (Date.now() - startedAt < timeoutMs);
  return last;
}
