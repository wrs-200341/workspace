import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, describe, expect, it } from 'vitest';
import { clearProductSummaryCache, lookupProductSummary, productPidFromReferenceName } from './productSummary';

const filePath = path.join('D:\\all_projects\\workspace\\data', `product-summary-test-${process.pid}.xlsx`);

afterEach(() => {
  clearProductSummaryCache();
  fs.rmSync(filePath, { force: true });
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
});
