import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';

const HELP = `Authenticated workspace GET benchmark (Node 22+).

Required environment:
  WORKSPACE_PERF_USERNAME / WORKSPACE_PERF_PASSWORD
Optional environment:
  BASE_URL                         http://127.0.0.1:3000
  WORKSPACE_PERF_BASE_URL           alias for BASE_URL
  WORKSPACE_PERF_ACCOUNT_ID         otherwise discover an accessible account
  WORKSPACE_PERF_DATE               Shanghai date, defaults to today
  WORKSPACE_PERF_CONCURRENCY        1..16, default 8
  WORKSPACE_PERF_DURATION_SECONDS   20..60, default 30
  WORKSPACE_PERF_WARMUP_SECONDS     1..20, default 5
  WORKSPACE_PERF_PAUSE_MS           100..5000, default 100 per virtual user
  WORKSPACE_PERF_TIMEOUT_MS         1000..30000, default 15000
  WORKSPACE_PERF_REPORT_PATH        optional new JSON file, never overwritten

Only login is POSTed (it creates a session). Benchmark requests are GETs.
Bodies are fully read. No task submissions, actions, or gallery searches run.
Cold snapshots omit a queue token; they do not flush server or OS caches.
Credentials, cookies, task data, and raw response/error text are not reported.`;

class BenchmarkError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new BenchmarkError(`invalid_${name}`);
  return value;
}

function configuration() {
  const username = process.env.WORKSPACE_PERF_USERNAME;
  const password = process.env.WORKSPACE_PERF_PASSWORD;
  if (!username || !password) throw new BenchmarkError('benchmark_credentials_required');
  let base;
  try { base = new URL(process.env.BASE_URL || process.env.WORKSPACE_PERF_BASE_URL || 'http://127.0.0.1:3000'); }
  catch { throw new BenchmarkError('invalid_BASE_URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new BenchmarkError('BASE_URL_must_be_an_origin_without_credentials');
  const date = process.env.WORKSPACE_PERF_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const dateMs = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== date) throw new BenchmarkError('invalid_WORKSPACE_PERF_DATE');
  return {
    origin: base.origin, username, password, date,
    concurrency: integerEnv('WORKSPACE_PERF_CONCURRENCY', 8, 1, 16),
    durationMs: integerEnv('WORKSPACE_PERF_DURATION_SECONDS', 30, 20, 60) * 1000,
    warmupMs: integerEnv('WORKSPACE_PERF_WARMUP_SECONDS', 5, 1, 20) * 1000,
    pauseMs: integerEnv('WORKSPACE_PERF_PAUSE_MS', 100, 100, 5000),
    timeoutMs: integerEnv('WORKSPACE_PERF_TIMEOUT_MS', 15000, 1000, 30000),
    accountId: process.env.WORKSPACE_PERF_ACCOUNT_ID || undefined,
    reportPath: process.env.WORKSPACE_PERF_REPORT_PATH || undefined,
  };
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

function envelope(body) {
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) throw new BenchmarkError('invalid_success_envelope');
  return body.data;
}

function serverDurations(header) {
  const allowed = new Set(['auth', 'queue', 'files', 'assets', 'folders', 'stats', 'db', 'sql', 'total', 'app', 'render', 'lookup', 'read']);
  const result = {};
  for (const entry of (header || '').split(',')) {
    const name = entry.split(';', 1)[0].trim();
    const duration = entry.match(/;\s*dur\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (allowed.has(name) && duration && Number.isFinite(Number(duration[1]))) result[name] = Number(duration[1]);
  }
  return result;
}

function safeFailure(error) {
  if (error instanceof BenchmarkError) return { code: error.code, status: error.status };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { code: 'request_timeout', status: 0 };
  return { code: 'network_or_response_failure', status: 0 };
}

async function fetchBody(config, cookie, pathname, options = {}) {
  const started = performance.now();
  let status = 0;
  let bytes = 0;
  let timing = {};
  try {
    const response = await fetch(new URL(pathname, config.origin), {
      method: options.method || 'GET',
      headers: { Accept: options.html ? 'text/html' : 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(options.timeoutMs || config.timeoutMs))),
    });
    status = response.status;
    timing = serverDurations(response.headers.get('Server-Timing'));
    const buffer = Buffer.from(await response.arrayBuffer());
    bytes = buffer.byteLength;
    const elapsedMs = performance.now() - started;
    if (status !== 200) throw new BenchmarkError(`http_${status}`, status);
    const contentType = response.headers.get('Content-Type') || '';
    let body;
    if (options.html) {
      if (!contentType.toLowerCase().includes('text/html') || !/<html(?:\s|>)/i.test(buffer.toString('utf8'))) throw new BenchmarkError('invalid_html_response', status);
    } else {
      if (!contentType.toLowerCase().includes('application/json')) throw new BenchmarkError('invalid_json_content_type', status);
      try { body = JSON.parse(buffer.toString('utf8')); }
      catch { throw new BenchmarkError('invalid_json_response', status); }
    }
    return { status, bytes, elapsedMs, timing, body, headers: response.headers };
  } catch (error) {
    return { status, bytes, elapsedMs: performance.now() - started, timing, error: safeFailure(error).code };
  }
}

function requireSuccess(result) {
  if (result.error) throw new BenchmarkError(result.error, result.status);
  return result;
}

async function authenticate(config) {
  const login = requireSuccess(await fetchBody(config, '', '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: config.username, password: config.password }) }));
  const data = envelope(login.body);
  if (!isRecord(data.user)) throw new BenchmarkError('invalid_login_response');
  const cookies = login.headers.getSetCookie().map((value) => value.split(';', 1)[0]).filter((value) => /^[^=\s]+=[^\r\n]*$/.test(value));
  if (!cookies.length) throw new BenchmarkError('login_session_cookie_missing');
  return cookies.join('; ');
}

async function discoverAccount(config, cookie) {
  const response = requireSuccess(await fetchBody(config, cookie, '/api/workspace/accounts'));
  const data = envelope(response.body);
  if (!Array.isArray(data.accounts)) throw new BenchmarkError('invalid_accounts_response');
  const accounts = data.accounts.filter((account) => isRecord(account) && typeof account.id === 'string' && account.id && typeof account.ownerId === 'string');
  const account = config.accountId ? accounts.find((item) => item.id === config.accountId) : accounts[0];
  if (!account) throw new BenchmarkError(config.accountId ? 'requested_account_not_accessible' : 'no_accessible_accounts');
  return account;
}

function validateQueue(body, kind) {
  const data = envelope(body);
  if (!Array.isArray(data.tasks) || data.tasks.length > 50 || !data.tasks.every((task) => isRecord(task) && typeof task.id === 'string' && typeof task.status === 'string')
    || !Array.isArray(data.deletedTaskIds) || !data.deletedTaskIds.every((id) => typeof id === 'string')
    || typeof data.token !== 'string' || !data.token || typeof data.reset !== 'boolean'
    || !isRecord(data.counts) || !['all', 'active', 'completed', 'failed', 'unsaved', 'safeRecoverable'].every((key) => isCount(data.counts[key]))
    || !isCount(data.page) || data.pageSize !== 50 || !Number.isInteger(data.totalPages) || data.totalPages < 1 || data.page >= data.totalPages) throw new BenchmarkError('invalid_queue_delta_schema');
  if (kind === 'cold_snapshot' && !data.reset) throw new BenchmarkError('cold_snapshot_did_not_reset');
  return data;
}

function endpoints(config, account) {
  const accountPath = `/workspace/accounts/${encodeURIComponent(account.id)}`;
  const owner = new URLSearchParams({ ownerId: account.ownerId });
  const routes = [
    { name: 'workspace', path: '/workspace', html: true },
    { name: 'production', path: `${accountPath}/production?mode=video`, html: true },
    { name: 'assets', path: `${accountPath}/assets`, html: true },
    { name: 'stats', path: `/api/workspace/video-stats?${owner}`, validate: (body) => {
      const data = envelope(body);
      if (!isRecord(data.counters) || !Array.isArray(data.rows) || !isRecord(data.summary) || !['inventorySavedToday', 'completedNotInInventory', 'running', 'queued', 'failed'].every((key) => isCount(data.summary[key]))) throw new BenchmarkError('invalid_stats_schema');
    } },
    { name: 'product_folders', path: `/api/workspace/product-images?${new URLSearchParams({ accountId: account.id })}`, validate: (body) => {
      if (!Array.isArray(envelope(body).folders)) throw new BenchmarkError('invalid_product_folders_schema');
    } },
    { name: 'asset_product_folders', path: `/api/workspace/accounts/${encodeURIComponent(account.id)}/product-images`, validate: (body) => {
      const data = envelope(body);
      if (data.accountId !== account.id || !Array.isArray(data.imported) || !Array.isArray(data.folders)) throw new BenchmarkError('invalid_asset_product_folders_schema');
    } },
  ];
  for (const mode of ['video', 'image', 'prompt']) {
    const query = new URLSearchParams({ queue: 'delta', scope: 'owner', ownerId: account.ownerId, date: config.date, tab: 'all', page: '0', limit: '50' });
    const path = `/api/workspace/accounts/${encodeURIComponent(account.id)}/${mode}-tasks?${query}`;
    for (const kind of ['cold_snapshot', 'delta']) routes.push({ name: `queue.${mode}.${kind}`, path, mode, kind });
  }
  return routes;
}

function percentile(values, ratio) {
  return values.length ? Math.round(values[Math.max(0, Math.ceil(values.length * ratio) - 1)] * 100) / 100 : null;
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.length ? Math.round(sorted.at(-1) * 100) / 100 : null };
}

function summarize(samples, elapsedMs) {
  const routes = {};
  for (const name of [...new Set(samples.map((sample) => sample.name))].sort()) {
    const selected = samples.filter((sample) => sample.name === name);
    const errors = {};
    const statuses = {};
    const timings = {};
    for (const sample of selected) {
      statuses[sample.status] = (statuses[sample.status] || 0) + 1;
      if (sample.error) errors[sample.error] = (errors[sample.error] || 0) + 1;
      for (const [metric, duration] of Object.entries(sample.timing)) (timings[metric] ||= []).push(duration);
    }
    routes[name] = {
      requests: selected.length,
      failures: selected.filter((sample) => sample.error).length,
      latencyMs: distribution(selected.map((sample) => sample.elapsedMs)),
      successLatencyMs: distribution(selected.filter((sample) => !sample.error).map((sample) => sample.elapsedMs)),
      bodyBytes: { total: selected.reduce((sum, sample) => sum + sample.bytes, 0), ...distribution(selected.map((sample) => sample.bytes)) },
      statuses, errors,
      serverTimingMs: Object.fromEntries(Object.entries(timings).map(([metric, values]) => [metric, distribution(values)])),
    };
  }
  return { elapsedMs: Math.round(elapsedMs), requests: samples.length, failures: samples.filter((sample) => sample.error).length, requestsPerSecond: Math.round(samples.length / (elapsedMs / 1000) * 100) / 100, routes };
}

async function runPhase(config, cookie, routes, durationMs, seeds = new Map(), ensureCoverage = false) {
  const samples = [];
  const tokens = new Map(seeds);
  const started = performance.now();
  const deadline = started + durationMs;
  let stopReason;
  let warmRoute = 0;
  await Promise.all(Array.from({ length: config.concurrency }, async (_, worker) => {
    const ownTokens = new Map(seeds);
    let turn = worker;
    while (!stopReason && (performance.now() < deadline || (ensureCoverage && warmRoute < routes.length))) {
      const route = routes[(ensureCoverage ? warmRoute++ : turn++) % routes.length];
      const query = new URL(route.path, config.origin);
      const since = route.kind === 'delta' ? ownTokens.get(route.mode) || tokens.get(route.mode) : undefined;
      if (since) query.searchParams.set('since', since);
      const result = await fetchBody(config, cookie, query.pathname + query.search, { html: route.html });
      let name = route.name;
      if (!result.error) {
        try {
          if (route.mode) {
            const delta = validateQueue(result.body, route.kind);
            ownTokens.set(route.mode, delta.token);
            tokens.set(route.mode, delta.token);
            if (route.kind === 'delta') name = `queue.${route.mode}.${delta.reset ? 'reset' : delta.tasks.length || delta.deletedTaskIds.length ? 'changed' : 'unchanged'}`;
          } else route.validate?.(result.body);
        } catch (error) { result.error = safeFailure(error).code; }
      }
      // Retain measurements only. Response bodies, cookies and tokens are never
      // included in reports or per-request error diagnostics.
      samples.push({ name, status: result.status, bytes: result.bytes, elapsedMs: result.elapsedMs, timing: result.timing, ...(result.error ? { error: result.error } : {}) });
      if ([401, 403, 429].includes(result.status)) stopReason = result.status === 429 ? 'rate_limited' : 'authorization_failed';
      const remaining = deadline - performance.now();
      if (!stopReason && (remaining > 0 || (ensureCoverage && warmRoute < routes.length))) await pause(config.pauseMs);
    }
  }));
  return { summary: { ...summarize(samples, performance.now() - started), ...(stopReason ? { stopReason } : {}) }, tokens };
}

function printPhase(label, phase) {
  console.log(`${label}: ${phase.requests} requests, ${phase.failures} failures, ${phase.requestsPerSecond} requests/second`);
  console.table(Object.entries(phase.routes).map(([route, result]) => ({ route, requests: result.requests, failures: result.failures, p50_ms: result.latencyMs.p50, p95_ms: result.latencyMs.p95, p99_ms: result.latencyMs.p99, max_ms: result.latencyMs.max, p50_bytes: result.bodyBytes.p50 })));
  if (phase.stopReason) console.log(`Stopped: ${phase.stopReason}`);
  const failures = Object.fromEntries(Object.entries(phase.routes).filter(([, result]) => result.failures).map(([route, result]) => [route, result.errors]));
  if (Object.keys(failures).length) console.log(JSON.stringify({ errors: failures }));
  const timings = Object.fromEntries(Object.entries(phase.routes).filter(([, result]) => Object.keys(result.serverTimingMs).length).map(([route, result]) => [route, result.serverTimingMs]));
  if (Object.keys(timings).length) console.log(JSON.stringify({ serverTimingMs: timings }));
}

async function main() {
  if (process.argv.includes('--help')) { console.log(HELP); return; }
  if (process.argv.length > 2) throw new BenchmarkError('unsupported_arguments_use_environment_or_help');
  const config = configuration();
  const cookie = await authenticate(config);
  const account = await discoverAccount(config, cookie);
  const routes = endpoints(config, account);
  console.log(`Authenticated. Warm-up: ${config.warmupMs / 1000}s; measured: ${config.durationMs / 1000}s; virtual users: ${config.concurrency}; pause: ${config.pauseMs}ms.`);
  const warmup = await runPhase(config, cookie, routes, config.warmupMs, new Map(), true);
  printPhase('Warm-up (excluded from measured results)', warmup.summary);
  if (warmup.summary.stopReason) throw new BenchmarkError(`warmup_${warmup.summary.stopReason}`);
  const measured = await runPhase(config, cookie, routes, config.durationMs, warmup.tokens);
  printPhase('Measured', measured.summary);
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    configuration: { concurrency: config.concurrency, durationSeconds: config.durationMs / 1000, warmupSeconds: config.warmupMs / 1000, pauseMs: config.pauseMs, timeoutMs: config.timeoutMs },
    notes: ['One authenticated session shared by independent virtual users; not multiple identities.', 'HTML/API response timing only; browser rendering and client navigation are not measured.', 'Cold snapshot means no client token, not an empty server or OS cache.', 'Body byte measurements are fully consumed, decompressed response bodies.', 'Latency ends after the entire response body is read; server timings are reported separately.', 'Warm-up attempts every endpoint and uses samples separate from the measured phase.', 'Phase durations limit new measured requests; in-flight requests drain within the configured timeout.'],
    warmup: warmup.summary, measured: measured.summary,
  };
  if (config.reportPath) {
    try { await writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch { throw new BenchmarkError('report_write_failed_path_must_be_new_and_parent_must_exist'); }
    console.log('JSON report written.');
  }
  if (measured.summary.failures || warmup.summary.failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Benchmark failed: ${safeFailure(error).code}`);
  process.exitCode = 1;
});
