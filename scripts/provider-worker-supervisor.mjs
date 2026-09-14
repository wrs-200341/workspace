import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';
import {
  clearDrainRequest,
  drainRequestMatchesSupervisor,
  providerControlPaths,
  readDrainRequest,
  removeFileIfExists,
  writeSupervisorState,
} from './provider-worker-control.mjs';

const entry = fileURLToPath(new URL('./provider-worker.ts', import.meta.url));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEnvConfig } = nextEnv;
loadEnvConfig(root);
const dataRoot = resolve(process.env.WORKSPACE_DATA_ROOT || join(root, 'data'));
const paths = providerControlPaths(root, dataRoot);
const state = {
  pid: process.pid,
  nonce: randomUUID(),
  root,
  script: fileURLToPath(import.meta.url),
  startedAt: new Date().toISOString(),
};
let stopping = false;
let child;
let restartTimer;
let drainPoller;

function publishState(extra = {}) {
  writeSupervisorState(paths, { ...state, ...extra, updatedAt: new Date().toISOString() });
}

function start() {
  if (stopping) return;
  child = fork(entry, process.argv.slice(2), { execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  publishState({ childPid: child.pid });
  child.on('error', (error) => console.error('Provider worker process error:', error.message));
  child.on('exit', (code, signal) => {
    child = undefined;
    publishState({ childPid: undefined, lastChildExit: code ?? signal ?? 'unknown' });
    if (stopping || process.argv.includes('--once')) { process.exitCode = code ?? 0; return; }
    console.error(`Provider worker exited (${code ?? signal}); restarting in 5 seconds.`);
    restartTimer = setTimeout(start, 5000);
  });
}

function drain(reason = 'signal') {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  clearInterval(drainPoller);
  clearDrainRequest(paths, state);
  publishState({ stopping: true, stopReason: reason });
  if (child?.connected) child.send('drain');
  else {
    removeFileIfExists(paths.stateFile);
    process.exitCode = 0;
  }
}

function checkDrainRequest() {
  const request = readDrainRequest(paths);
  if (drainRequestMatchesSupervisor(request, state)) drain(request.reason || 'file-request');
}

process.on('SIGINT', () => drain('SIGINT'));
process.on('SIGTERM', () => drain('SIGTERM'));
process.on('message', (message) => { if (message === 'drain') drain('ipc'); });
publishState();
clearDrainRequest(paths, state);
drainPoller = setInterval(checkDrainRequest, 1000);
drainPoller.unref?.();
start();
