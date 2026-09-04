import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, describe, expect, it } from 'vitest';
import { appendProductSummary, clearProductSummaryCache, getProductSummaryWorkbookInfo, lookupProductSummary, lookupProductSummaryForAccount, productPidFromReferenceName, saveProductSummaryWorkbook } from './productSummary';

const filePath = path.join('D:\\all_projects\\workspace\\data', `product-summary-test-${process.pid}.xlsx`);
const accountId = `summary-test-${process.pid}`;
const accountPath = path.join('D:\\all_projects\\workspace\\data', 'product-summaries', `${accountId}.xlsx`);
const accountMetaPath = accountPath.replace(/\.xlsx$/, '.json');

afterEach(() => {
  clearProductSummaryCache();
  fs.rmSync(filePath, { force: true });
  fs.rmSync(accountPath, { force: true });
  fs.rmSync(accountMetaPath, { force: true });
});

describe('product summary lookup', () => {
  it('extracts the pid prefix before a suffix and extension', () => {
    expect(productPidFromReferenceName('173453212_xx.jpg')).toBe('173453212');
    expect(productPidFromReferenceName('173453212-extra.webp')).toBe('173453212');
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
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([{ pid: '42', title: 'Uploaded item', description: 'Account specific' }]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'products');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const uploadBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(uploadBuffer).set(bytes);
    const info = saveProductSummaryWorkbook(accountId, { name: 'catalog.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: bytes.length, arrayBuffer: uploadBuffer });
    expect(info.source).toBe('account');
    expect(info.rowCount).toBe(1);
    expect(lookupProductSummaryForAccount(accountId, '42_variant.png')).toEqual({ pid: '42', title: 'Uploaded item', description: 'Account specific' });
    expect(getProductSummaryWorkbookInfo(accountId).fileName).toBe('catalog.xlsx');
  });
});
