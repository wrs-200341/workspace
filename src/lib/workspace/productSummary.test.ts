import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendProductSummary, clearProductSummaryCache, getProductSummaryWorkbookInfo, lookupProductSummary, lookupProductSummaryForAccount, productPidFromReferenceName, saveProductSummaryWorkbook } from './productSummary';

const testParent = path.resolve('D:\\all_projects\\workspace\\data');
let testRoot: string;
let filePath: string;
const accountId = `summary-test-${process.pid}`;
let accountPath: string;
let accountMetaPath: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(testParent, 'product-summary-tests-'));
  vi.stubEnv('WORKSPACE_DATA_ROOT', testRoot);
  vi.stubEnv('WORKSPACE_PRODUCT_SUMMARY_PATH', '');
  filePath = path.join(testRoot, 'catalog.xlsx');
  accountPath = path.join(testRoot, 'product-summaries', `${accountId}.xlsx`);
  accountMetaPath = accountPath.replace(/\.xlsx$/, '.json');
  clearProductSummaryCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProductSummaryCache();
  if (testRoot && path.dirname(path.resolve(testRoot)) === testParent && path.basename(testRoot).startsWith('product-summary-tests-')) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

function workbookBytes(title = 'Uploaded item'): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ pid: '42', title, description: 'Account specific' }]), 'products');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function writeWorkbook(destination: string, title = 'Uploaded item'): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, workbookBytes(title));
}

function uploadWorkbook(owner = accountId, title = 'Uploaded item', name = 'catalog.xlsx') {
  const bytes = workbookBytes(title);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return saveProductSummaryWorkbook(owner, { name, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: bytes.length, arrayBuffer });
}

function spyOnWorkbookReads() {
  const spy = vi.spyOn(fs, 'readFileSync');
  return { count: () => spy.mock.calls.filter(([target]) => typeof target === 'string' && /\.xlsx$/i.test(target)).length };
}

describe('product summary lookup', () => {
  it('extracts the pid prefix before a suffix and extension', () => {
    expect(productPidFromReferenceName('173453212_xx.jpg')).toBe('173453212');
    expect(productPidFromReferenceName('173453212-extra.webp')).toBe('173453212');
    expect(productPidFromReferenceName('173453212 · 001.jpg')).toBe('173453212');
  });

  it('reads title and description from the workbook by pid', () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([{ pid: '173453212', 标题: 'Summer dress', 产品描述: 'Lightweight and breathable' }]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'products');
    XLSX.writeFile(workbook, filePath);
    expect(lookupProductSummary('173453212_xx.png', filePath)).toEqual({ pid: '173453212', title: 'Summer dress', description: 'Lightweight and breathable' });
    expect(lookupProductSummary('999999_xx.png', filePath)).toBeNull();
  });

  it('appends matched fields to the final video prompt', () => {
    expect(appendProductSummary('Show the product in a studio', { pid: '173453212', title: 'Summer dress', description: 'Lightweight and breathable' })).toBe('Show the product in a studio\n\n商品资料（来自 Excel）\n标题：Summer dress\n描述：Lightweight and breathable');
    expect(appendProductSummary('  Keep the original prompt  ', null)).toBe('Keep the original prompt');
  });

  it('stores and resolves an account-scoped uploaded workbook', () => {
    const info = uploadWorkbook();
    expect(info.source).toBe('account');
    expect(info.rowCount).toBe(1);
    expect(lookupProductSummaryForAccount(accountId, '42_variant.png')).toEqual({ pid: '42', title: 'Uploaded item', description: 'Account specific' });
    expect(getProductSummaryWorkbookInfo(accountId).fileName).toBe('catalog.xlsx');
    const stat = fs.statSync(accountPath);
    expect(JSON.parse(fs.readFileSync(accountMetaPath, 'utf8'))).toEqual({ fileName: 'catalog.xlsx', rowCount: 1, workbook: { mtimeMs: stat.mtimeMs, size: stat.size } });
  });

  it('reads uploaded workbook info without reading workbook bytes', () => {
    uploadWorkbook();
    clearProductSummaryCache();
    const reads = spyOnWorkbookReads();
    expect(getProductSummaryWorkbookInfo(accountId)).toMatchObject({ source: 'account', fileName: 'catalog.xlsx', rowCount: 1 });
    expect(reads.count()).toBe(0);
  });

  it('preserves legacy metadata names with an unknown row count without parsing', () => {
    writeWorkbook(accountPath);
    fs.writeFileSync(accountMetaPath, JSON.stringify({ fileName: 'legacy-catalog.xlsx' }));
    const reads = spyOnWorkbookReads();
    expect(getProductSummaryWorkbookInfo(accountId)).toMatchObject({ source: 'account', fileName: 'legacy-catalog.xlsx', rowCount: null, size: fs.statSync(accountPath).size });
    expect(reads.count()).toBe(0);
  });

  it('reports no workbook separately from an unknown legacy row count', () => {
    expect(getProductSummaryWorkbookInfo(accountId)).toEqual({ accountId, source: 'none', fileName: null, rowCount: 0, size: 0, updatedAt: null });
    writeWorkbook(accountPath);
    expect(getProductSummaryWorkbookInfo(accountId)).toMatchObject({ source: 'account', fileName: `${accountId}.xlsx`, rowCount: null });
  });

  it('uses metadata belonging to the selected default workbook, not the account', () => {
    uploadWorkbook('default', 'Shared product', 'shared-catalog.xlsx');
    fs.writeFileSync(accountMetaPath, JSON.stringify({ fileName: 'unrelated-account.xlsx', rowCount: 99, workbook: fs.statSync(path.join(testRoot, 'product-summaries', 'default.xlsx')) }));
    const reads = spyOnWorkbookReads();
    expect(getProductSummaryWorkbookInfo(accountId)).toMatchObject({ source: 'default', fileName: 'default.xlsx', rowCount: 1 });
    expect(reads.count()).toBe(0);
  });

  it('discards stale persisted counts when workbook bytes are replaced', () => {
    uploadWorkbook();
    writeWorkbook(accountPath, 'A replacement with a different byte length');
    const reads = spyOnWorkbookReads();
    expect(getProductSummaryWorkbookInfo(accountId)).toMatchObject({ fileName: 'catalog.xlsx', source: 'account', rowCount: null });
    expect(reads.count()).toBe(0);
  });

  it('reuses parsed rows across multiple workbook paths and equivalent resolved paths', () => {
    const second = path.join(testRoot, 'second.xlsx');
    writeWorkbook(filePath, 'First');
    writeWorkbook(second, 'Second');
    const reads = spyOnWorkbookReads();
    expect(lookupProductSummary('42', filePath)?.title).toBe('First');
    expect(lookupProductSummary('42', second)?.title).toBe('Second');
    expect(lookupProductSummary('42', filePath)?.title).toBe('First');
    expect(lookupProductSummary('42', path.relative(process.cwd(), second))?.title).toBe('Second');
    expect(reads.count()).toBe(2);
  });

  it('retains at most eight parsed workbook entries', () => {
    const paths = Array.from({ length: 9 }, (_, index) => path.join(testRoot, `${index}.xlsx`));
    for (const [index, destination] of paths.entries()) writeWorkbook(destination, String(index));
    const reads = spyOnWorkbookReads();
    for (const [index, destination] of paths.entries()) expect(lookupProductSummary('42', destination)?.title).toBe(String(index));
    expect(reads.count()).toBe(9);
    expect(lookupProductSummary('42', paths[8])?.title).toBe('8');
    expect(reads.count()).toBe(9);
    expect(lookupProductSummary('42', paths[0])?.title).toBe('0');
    expect(reads.count()).toBe(10);
  });

  it('invalidates parsed rows for either a size change or an mtime change', () => {
    writeWorkbook(filePath, 'First');
    const stableTime = new Date('2024-01-01T00:00:00Z');
    fs.utimesSync(filePath, stableTime, stableTime);
    const reads = spyOnWorkbookReads();
    expect(lookupProductSummary('42', filePath)?.title).toBe('First');
    writeWorkbook(filePath, 'Longer replacement');
    fs.utimesSync(filePath, stableTime, stableTime);
    expect(lookupProductSummary('42', filePath)?.title).toBe('Longer replacement');
    const changedTime = new Date('2024-01-02T00:00:00Z');
    fs.utimesSync(filePath, changedTime, changedTime);
    expect(lookupProductSummary('42', filePath)?.title).toBe('Longer replacement');
    expect(reads.count()).toBe(3);
  });

  it('replacing one uploaded workbook preserves other account caches', () => {
    uploadWorkbook(accountId, 'Old account');
    uploadWorkbook('other-account', 'Other account');
    expect(lookupProductSummaryForAccount(accountId, '42')?.title).toBe('Old account');
    expect(lookupProductSummaryForAccount('other-account', '42')?.title).toBe('Other account');
    uploadWorkbook(accountId, 'Replaced account');
    const reads = spyOnWorkbookReads();
    expect(lookupProductSummaryForAccount('other-account', '42')?.title).toBe('Other account');
    expect(reads.count()).toBe(0);
    expect(lookupProductSummaryForAccount(accountId, '42')?.title).toBe('Replaced account');
  });
});
