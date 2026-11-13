import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  buildCategoryLabel,
  calculateInventorySummary,
  DEMO_RAW_PACKAGES,
  formatInventoryAsNotepadText,
  inferPackageType,
  mergeInventoryItems,
  normalizeCustomerName,
} from './inventory';
import { buildInventoryWorkbook } from './excelExport';

test('categorizes Microsoft Del001234567 as Kund Microsoft Delivery', () => {
  const merged = mergeInventoryItems([], [
    {
      customer: 'Microsoft',
      type: 'Delivery',
      referenceNumber: 'Del001234567',
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].customer, 'Microsoft');
  assert.equal(merged[0].type, 'Delivery');
  assert.equal(merged[0].categoryLabel, 'Kund Microsoft Delivery');
  assert.equal(merged[0].referenceNumber, 'Del001234567');
  assert.equal(merged[0].quantity, 1);
});

test('deduplicates two identical delivery numbers and sums Antal to 2', () => {
  const merged = mergeInventoryItems([], [
    {
      customer: 'MICROSOFT',
      type: 'Delivery',
      referenceNumber: 'Del001234567',
      timestamp: '00:02',
    },
    {
      customer: 'microsoft',
      type: 'Delivery',
      referenceNumber: 'DEL 001234567',
      timestamp: '00:06',
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].customer, 'Microsoft');
  assert.equal(merged[0].categoryLabel, 'Kund Microsoft Delivery');
  assert.equal(merged[0].quantity, 2);
  assert.deepEqual(merged[0].timestamps, ['00:02', '00:06']);
});

test('infers Removal from Rem prefix and preserves acronyms', () => {
  assert.equal(inferPackageType(undefined, 'Rem00441122'), 'Removal');
  assert.equal(normalizeCustomerName('dhl'), 'DHL');
  assert.equal(buildCategoryLabel('IBM', 'Removal'), 'Kund IBM Removal');
});

test('flags low-confidence reads for human review without dropping them', () => {
  const merged = mergeInventoryItems([], DEMO_RAW_PACKAGES);
  const summary = calculateInventorySummary(merged);

  assert.equal(summary.totalPackages, 8);
  assert.equal(summary.uniqueCount, 5);
  assert.equal(summary.deliveryCount, 6);
  assert.equal(summary.removalCount, 2);
  assert.equal(summary.reviewNeededCount, 1);

  const msDelivery = merged.find((i) => i.referenceNumber === 'Del001234567');
  assert.ok(msDelivery);
  assert.equal(msDelivery.quantity, 2);
});

test('formats notepad text and Excel workbook accurately', () => {
  const items = mergeInventoryItems([], DEMO_RAW_PACKAGES);
  const text = formatInventoryAsNotepadText(items, 'Lagerpass 1');

  assert.match(text, /KUND MICROSOFT DELIVERY/);
  assert.match(text, /Del001234567\s+\|\s+Antal: 2 st/);

  const workbook = buildInventoryWorkbook(items, 'Lagerpass 1');
  assert.deepEqual(workbook.SheetNames, ['Inventering', 'Sammanfattning']);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['Inventering']);
  const msRow = rows.find((r) => r['Delivery- / Removalnummer'] === 'Del001234567');
  assert.ok(msRow);
  assert.equal(msRow['Kategori'], 'Kund Microsoft Delivery');
  assert.equal(msRow['Antal'], 2);
});
