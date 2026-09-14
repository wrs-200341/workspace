import { resolve, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

// One-time bridge for the JSON-era server, which has no shutdown flush hook.
// It only uses an already-open loopback inspector and validates the target.
const root = resolve(process.cwd());
const pid = Number(process.argv.find((arg) => arg.startsWith('--pid='))?.slice(6));
const stop = process.argv.includes('--stop');
const timeoutMs = Math.min(900000, Math.max(1000, Number(process.argv.find((arg) => arg.startsWith('--timeout-ms='))?.slice(13) || 60000)));
const startedAt = Date.now();
const reportFile = join(root, 'data', 'providers', 'legacy-drain-report.json');
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Pass --pid=<legacy server PID>.');
const targets = await fetch('http://127.0.0.1:9229/json/list').then((response) => response.json());
const url = targets[0]?.webSocketDebuggerUrl;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Loopback inspector unavailable.');
const socket = new WebSocket(url);
await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener('close', () => {
  for (const request of pending.values()) {
    if (stop) request.resolve({ disconnected: true });
    else request.reject(new Error('legacy_inspector_disconnected'));
  }
  pending.clear();
});
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (stop && message.error?.code === -32000 && existsSync(reportFile) && statSync(reportFile).mtimeMs >= startedAt) request.resolve({ flushedAndStopped: true });
  else if (message.error || message.result?.exceptionDetails) request.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
  else request.resolve(message.result?.result?.value);
});
function evaluate(expression) {
  return new Promise((resolveResult, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveResult, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
try {
  const setup = await evaluate(`(() => {
    if (process.pid !== ${pid} || process.cwd().toLowerCase() !== ${JSON.stringify(root.toLowerCase())}) throw new Error('legacy_target_mismatch');
    const req = process.mainModule.require;
    const cache = req('node:module')._cache;
    const runtime = Object.values(cache).find(m => m.filename.toLowerCase() === ${JSON.stringify(join(root, '.next', 'server', 'webpack-runtime.js').toLowerCase())})?.exports;
    if (!runtime?.m) throw new Error('legacy_runtime_not_loaded');
    const id = Object.keys(runtime.m).find(id => runtime.m[id].toString().includes('provider_tasks_flush_failed'));
    if (!id) throw new Error('legacy_task_store_not_loaded');
    const exports = Object.values(runtime(id));
    const flush = exports.find(fn => typeof fn === 'function' && fn.toString().includes('provider_tasks_flush_failed'));
    const list = exports.find(fn => typeof fn === 'function' && fn.toString().includes('return(function()') && fn.toString().includes('accountIds'));
    const servers = process._getActiveHandles().filter(h => typeof h.listen === 'function' && typeof h.address === 'function' && h.address()?.port === 3000 && typeof h.listeners === 'function');
    if (!flush || !list || servers.length !== 1) return { diagnostic:true, flush:!!flush, list:!!list, servers:servers.length, exports:exports.filter(fn=>typeof fn==='function').map(fn=>fn.toString().slice(0,160)) };
    globalThis.__legacyTaskDrain = { flush, list, server: servers[0] };
    const tasks = list();
    return { pid: process.pid, tasks: tasks.length, unaccepted: tasks.filter(t => ['prompting','submitting','queued','retrying','running','processing'].includes(t.status) && !t.providerTaskId).map(t => ({ id:t.id,status:t.status })) };
  })()`);
  console.log(JSON.stringify(setup));
  if (setup?.diagnostic) throw new Error('legacy_drain_exports_unavailable');
  if (stop) {
    if (existsSync(reportFile)) throw new Error('A legacy drain report already exists; refusing a repeated stop.');
    const disconnectAfterFlush = setInterval(() => {
      if (existsSync(reportFile) && statSync(reportFile).mtimeMs >= startedAt) socket.close();
    }, 100);
    try {
      const result = await evaluate(`(async () => {
      const state = globalThis.__legacyTaskDrain;
      const listeners = state.server.listeners('request');
      const gate = function(req, res) {
        if (['GET','HEAD'].includes(req.method)) {
          for (const listener of listeners) listener.call(this, req, res);
          return;
        }
        res.writeHead(503, { 'Content-Type':'application/json', 'Retry-After':'15', 'Cache-Control':'no-store' });
        res.end(JSON.stringify({success:false,error:'maintenance_task_storage_migration'}));
      };
      state.server.removeAllListeners('request');
      state.server.on('request', gate);
      try {
        const deadline = Date.now() + ${timeoutMs};
        while (true) {
          const active = state.list().filter(t => ['prompting','submitting','queued','retrying','running','processing'].includes(t.status) && !t.providerTaskId);
          if (!active.length) break;
          if (Date.now() >= deadline) throw new Error('legacy_unaccepted_work_still_running');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await state.flush();
        const tasks = state.list();
        if (tasks.some(t => ['prompting','submitting','queued','retrying','running','processing'].includes(t.status) && !t.providerTaskId)) throw new Error('legacy_work_started_during_flush');
        const fs = process.mainModule.require('node:fs');
        const crypto = process.mainModule.require('node:crypto');
        const source = ${JSON.stringify(join(root, 'data', 'providers', 'tasks.json'))};
        const disk = fs.readFileSync(source);
        const parsed = JSON.parse(disk);
        if (tasks.length !== parsed.length || tasks.some(t => !parsed.some(p => p.id === t.id && p.updatedAt === t.updatedAt))) throw new Error('legacy_final_flush_verification_failed');
        const report = { pid:process.pid, stoppedAt:new Date().toISOString(), tasks:tasks.length, sourceSha256:crypto.createHash('sha256').update(disk).digest('hex'), acceptedIds:tasks.filter(t=>t.providerTaskId && !['completed','failed','cancelled'].includes(t.status)).map(t=>({id:t.id,providerTaskId:t.providerTaskId,status:t.status})) };
        fs.writeFileSync(${JSON.stringify(join(root, 'data', 'providers', 'legacy-drain-report.json'))}, JSON.stringify(report,null,2), {flag:'wx'});
        // Flush and exit in this same continuation, before any poll callback can write again.
        process.exit(0);
      } catch (error) {
        state.server.removeListener('request', gate);
        for (const listener of listeners) state.server.on('request',listener);
        throw error;
      }
    })()`);
      console.log(result);
    } finally { clearInterval(disconnectAfterFlush); }
  }
} finally { socket.close(); }
