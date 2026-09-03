import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const DEFAULT_SUMMARY_PATH = 'C:\\Users\\EDY\\Downloads\\product_summary汇总_3.xlsx';
const MAX_DESCRIPTION_LENGTH = 8_000;
const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;

export type ProductSummary = { pid: string; title: string; description: string };
type SummaryRow = ProductSummary;
type SummaryCache = { filePath: string; mtimeMs: number; rows: Map<string, SummaryRow> };

let cache: SummaryCache | null = null;

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
  const match = base.match(/^([^_-]+)/);
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

export function clearProductSummaryCache(): void {
  cache = null;
}
