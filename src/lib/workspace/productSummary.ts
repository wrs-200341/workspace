import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { getWorkspacePath } from '../storagePaths';

const DEFAULT_SUMMARY_PATH = 'C:\\Users\\EDY\\Downloads\\product_summary汇总_3.xlsx';
const SUMMARY_DIR = 'product-summaries';
const MAX_DESCRIPTION_LENGTH = 8_000;
const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;

export type ProductSummary = { pid: string; title: string; description: string };
type SummaryRow = ProductSummary;
type SummaryCache = { filePath: string; mtimeMs: number; rows: Map<string, SummaryRow> };

let cache: SummaryCache | null = null;

function accountSummaryPath(accountId: string): string {
  const normalized = accountId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error('account_id_invalid');
  return getWorkspacePath(SUMMARY_DIR, `${normalized}.xlsx`);
}
function accountSummaryMetaPath(accountId: string): string {
  return accountSummaryPath(accountId).replace(/\.xlsx$/i, '.json');
}

function text(value: unknown, maxLength = MAX_DESCRIPTION_LENGTH): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function normalizePid(value: unknown): string {
  return text(value, 128).replace(/\.0$/, '');
}

function rowValue(row: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    const key = Object.keys(row).find((candidate) => candidate.trim().toLowerCase() === alias.toLowerCase());
    if (key) return row[key];
  }
  return undefined;
}

function loadRows(filePath: string): Map<string, SummaryRow> {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_WORKBOOK_BYTES) throw new Error('product_summary_file_invalid');
  if (cache && cache.filePath === filePath && cache.mtimeMs === stat.mtimeMs) return cache.rows;
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false, dense: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return new Map();
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '', raw: false }).slice(0, MAX_ROWS);
  const mapped = new Map<string, SummaryRow>();
  for (const row of rows) {
    const pid = normalizePid(rowValue(row, ['pid', '商品编号', '商品id', 'product id']));
    if (!pid) continue;
    mapped.set(pid, {
      pid,
      title: text(rowValue(row, ['标题', 'title', '商品标题']), 2_000),
      description: text(rowValue(row, ['产品描述', '描述', 'description', '商品描述']), MAX_DESCRIPTION_LENGTH),
    });
  }
  cache = { filePath, mtimeMs: stat.mtimeMs, rows: mapped };
  return mapped;
}

/** Extract the product id before the first underscore/dash in an image name. */
export function productPidFromReferenceName(referenceName: string | undefined): string | undefined {
  if (!referenceName?.trim()) return undefined;
  const base = path.basename(referenceName.trim()).replace(/\.[^.]+$/, '');
  // PID is the leading identifier in both uploaded names (`pid_xx.png`)
  // and imported product-image labels (`pid · 001.jpg`). Stop at any
  // separator commonly used by the asset UI instead of treating the whole
  // display label as the PID.
  const match = base.match(/^([A-Za-z0-9]+)/);
  const pid = normalizePid(match?.[1]);
  return pid || undefined;
}

export function lookupProductSummary(referenceName: string | undefined, filePath = process.env.WORKSPACE_PRODUCT_SUMMARY_PATH?.trim() || DEFAULT_SUMMARY_PATH): ProductSummary | null {
  const pid = productPidFromReferenceName(referenceName);
  if (!pid) return null;
  try {
    return loadRows(filePath).get(pid) ?? null;
  } catch {
    return null;
  }
}

/** Resolve an account-scoped workbook. An optional explicit environment path
 * is retained for controlled deployments, but the local template path is not
 * used implicitly: operators must upload the workbook that is current for
 * their account. */
export function productSummaryPathForAccount(accountId: string): string {
  const accountPath = accountSummaryPath(accountId);
  if (fs.existsSync(accountPath)) return accountPath;
  return process.env.WORKSPACE_PRODUCT_SUMMARY_PATH?.trim() || '';
}

/** Look up a product using the workbook uploaded for the current account. */
export function lookupProductSummaryForAccount(accountId: string, referenceName: string | undefined): ProductSummary | null {
  return lookupProductSummary(referenceName, productSummaryPathForAccount(accountId));
}

export type ProductSummaryWorkbookInfo = {
  accountId: string;
  fileName: string | null;
  size: number;
  updatedAt: string | null;
  source: 'account' | 'default' | 'none';
  rowCount: number;
};

export function getProductSummaryWorkbookInfo(accountId: string): ProductSummaryWorkbookInfo {
  const accountPath = accountSummaryPath(accountId);
  const accountExists = fs.existsSync(accountPath);
  const fallback = process.env.WORKSPACE_PRODUCT_SUMMARY_PATH?.trim() || '';
  const filePath = accountExists ? accountPath : fallback && fs.existsSync(fallback) ? fallback : null;
  if (!filePath) return { accountId: accountId.trim(), fileName: null, size: 0, updatedAt: null, source: 'none', rowCount: 0 };
  try {
    const stat = fs.statSync(filePath);
    const rows = loadRows(filePath);
    let originalName: string | null = null;
    try {
      const metadata = JSON.parse(fs.readFileSync(accountSummaryMetaPath(accountId), 'utf8')) as { fileName?: unknown };
      if (typeof metadata.fileName === 'string' && metadata.fileName.trim()) originalName = metadata.fileName.trim().slice(0, 120);
    } catch { /* metadata is optional for legacy uploads */ }
    return {
      accountId: accountId.trim(),
      fileName: accountExists ? (originalName || path.basename(filePath)) : path.basename(filePath),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      source: accountExists ? 'account' : 'default',
      rowCount: rows.size,
    };
  } catch {
    return { accountId: accountId.trim(), fileName: path.basename(filePath), size: 0, updatedAt: null, source: accountExists ? 'account' : 'default', rowCount: 0 };
  }
}

/** Validate and atomically persist a workbook uploaded for one account. */
export function saveProductSummaryWorkbook(accountId: string, file: { name: string; type: string; size: number; arrayBuffer: ArrayBuffer }): ProductSummaryWorkbookInfo {
  const destination = accountSummaryPath(accountId);
  const extension = path.extname(file.name).toLowerCase();
  const normalizedMime = file.type.trim().toLowerCase();
  if (!['.xlsx', '.xls'].includes(extension) || (normalizedMime && !normalizedMime.includes('spreadsheet') && !normalizedMime.includes('excel') && normalizedMime !== 'application/octet-stream')) throw new Error('product_summary_file_type_invalid');
  if (!file.size || file.size > MAX_WORKBOOK_BYTES) throw new Error('product_summary_file_invalid');
  const bytes = Buffer.from(file.arrayBuffer);
  if (!bytes.length) throw new Error('product_summary_file_invalid');
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp${extension}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  try {
    const workbook = XLSX.read(bytes, { cellDates: false, raw: false, dense: true });
    const firstSheet = workbook.SheetNames[0];
    const headerRows = firstSheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet], { header: 1, defval: '', raw: false }) : [];
    const headers = new Set((Array.isArray(headerRows[0]) ? headerRows[0] : []).map((value) => String(value).trim().toLowerCase()));
    const hasPid = ['pid', '商品编号', '商品id', 'product id'].some((value) => headers.has(value));
    const hasTitle = ['标题', 'title', '商品标题'].some((value) => headers.has(value));
    const hasDescription = ['产品描述', '描述', 'description', '商品描述'].some((value) => headers.has(value));
    if (!hasPid || !hasTitle || !hasDescription) throw new Error('product_summary_file_invalid');
    const rows = loadRows(temporary);
    if (rows.size === 0) throw new Error('product_summary_file_invalid');
    fs.renameSync(temporary, destination);
    fs.writeFileSync(accountSummaryMetaPath(accountId), JSON.stringify({ fileName: path.basename(file.name) }), { encoding: 'utf8', mode: 0o600 });
    clearProductSummaryCache();
    return { accountId: accountId.trim(), fileName: path.basename(file.name), size: bytes.length, updatedAt: new Date().toISOString(), source: 'account', rowCount: rows.size };
  } catch {
    throw new Error('product_summary_file_invalid');
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

/** Append the matched Excel fields to the exact prompt sent to a video model. */
export function appendProductSummary(prompt: string, summary: ProductSummary | null): string {
  const basePrompt = prompt.trim();
  if (!summary) return basePrompt;
  return `${basePrompt}\n\n商品资料（来自 Excel）\n标题：${summary.title}\n描述：${summary.description}`.trim();
}

export function clearProductSummaryCache(): void {
  cache = null;
}
