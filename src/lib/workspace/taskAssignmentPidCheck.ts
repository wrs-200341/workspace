const DEFAULT_BASE_URL = 'http://127.0.0.1:8003';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type TaskAssignmentPidCheckSource = 'tap' | 'cap';

export type TaskAssignmentPidCheckResult = {
  pid: string;
  source: TaskAssignmentPidCheckSource;
  canMount: boolean;
  reason: string;
  title?: string;
  price?: string;
  salesText?: string;
  commissionRate?: number;
  commissionAmount?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function configuredBaseUrl(): URL {
  const fallback = new URL(DEFAULT_BASE_URL);
  const configured = process.env.TASK_ASSIGNMENT_PID_CHECK_BASE_URL;
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    const allowedHosts = process.env.TASK_ASSIGNMENT_PID_CHECK_ALLOWED_HOSTS
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? ['127.0.0.1', 'localhost'];
    if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.includes(url.hostname)) return fallback;
    return url;
  } catch {
    return fallback;
  }
}

function endpoint(pathname: string, search = ''): URL {
  const url = configuredBaseUrl();
  url.pathname = pathname;
  url.search = search;
  return url;
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('pid_check_response_too_large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('pid_check_response_too_large');
  return text;
}

function timeoutSignal(): AbortSignal {
  const configured = Number(process.env.TASK_ASSIGNMENT_PID_CHECK_TIMEOUT_MS || 90_000);
  return AbortSignal.timeout(Math.max(3_000, Math.min(180_000, configured)));
}

function normalizeMoney(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^earn\s+/i, '');
  return normalized || undefined;
}

function calculatedCommission(price: unknown, rate: unknown, currency: unknown): string | undefined {
  const numericPrice = finiteNumber(price);
  const numericRate = finiteNumber(rate);
  if (numericPrice === null || numericRate === null) return undefined;
  const amount = numericPrice * numericRate / 100;
  const prefix = currency === 'USD' || !currency ? '$' : `${String(currency)} `;
  return `${prefix}${amount.toFixed(2)}`;
}

export function normalizeCapPidCheck(payload: unknown, pid: string): TaskAssignmentPidCheckResult {
  const rows = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  const item = rows.find((value) => isRecord(value) && String(value.product_id ?? value.pid ?? '').trim() === pid);
  if (!isRecord(item)) {
    return {
      pid,
      source: 'cap',
      canMount: true,
      reason: 'CAP 可挂车，暂未查到佣金额',
    };
  }

  const commissionRate = finiteNumber(item.commission_rate) ?? undefined;
  const commissionAmount = normalizeMoney(item.earn_amount)
    ?? calculatedCommission(item.price, commissionRate, item.currency);
  const numericPrice = finiteNumber(item.price);
  const price = typeof item.price === 'string'
    ? item.price.trim() || undefined
    : numericPrice === null
      ? undefined
      : `${item.currency === 'USD' || !item.currency ? '$' : `${String(item.currency)} `}${numericPrice.toFixed(2)}`;

  return {
    pid,
    source: 'cap',
    canMount: true,
    reason: commissionAmount ? 'CAP 可挂车' : 'CAP 可挂车，暂未查到佣金额',
    title: typeof item.product_name === 'string' ? item.product_name.trim() || undefined : undefined,
    price,
    salesText: typeof item.sales_text === 'string' ? item.sales_text.trim() || undefined : undefined,
    commissionRate,
    commissionAmount,
  };
}

export function normalizeTapPidCheck(events: readonly unknown[], pid: string): TaskAssignmentPidCheckResult {
  let completed = false;
  let failureReason = '';
  let fallbackMessage = '';

  for (const value of events) {
    if (!isRecord(value)) continue;
    if (value.type === 'progress' && String(value.pid ?? '') === pid) {
      const action = typeof value.action === 'string' ? value.action.trim() : '';
      if (['无campaign', '加入失败', '异常跳过'].includes(action)) failureReason ||= action;
    }
    if (value.type !== 'sheet_done') continue;
    completed = true;
    if (typeof value.message === 'string') fallbackMessage = value.message.trim();
    if (isRecord(value.failed_reasons)) {
      const reason = value.failed_reasons[pid];
      if (typeof reason === 'string' && reason.trim()) failureReason = reason.trim();
    }
  }

  if (!completed) throw new Error('pid_check_incomplete_response');
  if (failureReason) return { pid, source: 'tap', canMount: false, reason: failureReason };
  if (fallbackMessage.includes('无有效') || fallbackMessage.includes('失败')) {
    return { pid, source: 'tap', canMount: false, reason: fallbackMessage || '当前不可挂车' };
  }
  return { pid, source: 'tap', canMount: true, reason: 'TAP 可挂车' };
}

async function checkCap(pid: string): Promise<TaskAssignmentPidCheckResult> {
  const response = await fetch(endpoint('/api/cap/products/search-by-pids'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ product_ids: [pid] }),
    cache: 'no-store',
    signal: timeoutSignal(),
  });
  const text = await readLimitedText(response);
  if (!response.ok) throw new Error(`pid_check_upstream_${response.status}`);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('pid_check_invalid_response');
  }
  return normalizeCapPidCheck(payload, pid);
}

async function checkTap(pid: string): Promise<TaskAssignmentPidCheckResult> {
  const form = new FormData();
  form.append('file', new Blob([`PID\r\n${pid}\r\n`], { type: 'text/csv;charset=utf-8' }), 'pid-check.csv');
  const response = await fetch(endpoint('/api/product-pools/lists/import-excel', 'check_only=1&concurrency=1'), {
    method: 'POST',
    headers: { accept: 'application/x-ndjson' },
    body: form,
    cache: 'no-store',
    signal: timeoutSignal(),
  });
  const text = await readLimitedText(response);
  if (!response.ok) throw new Error(`pid_check_upstream_${response.status}`);
  const events = text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  return normalizeTapPidCheck(events, pid);
}

export async function checkTaskAssignmentPid(
  pidValue: unknown,
  sourceValue: unknown,
): Promise<TaskAssignmentPidCheckResult> {
  const pid = typeof pidValue === 'string' ? pidValue.trim() : '';
  if (!/^\d{6,30}$/.test(pid)) throw new Error('invalid_pid');
  if (sourceValue !== 'tap' && sourceValue !== 'cap') throw new Error('invalid_source');
  try {
    return sourceValue === 'cap' ? await checkCap(pid) : await checkTap(pid);
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('pid_check_timeout');
    throw error;
  }
}
