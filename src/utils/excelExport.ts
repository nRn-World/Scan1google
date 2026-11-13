import * as XLSX from 'xlsx';
import { calculateInventorySummary, type InventoryItem } from './inventory';

export function buildInventoryWorkbook(
  items: InventoryItem[],
  sessionTitle = 'Inventering'
): XLSX.WorkBook {
  const summary = calculateInventorySummary(items);

  const mainRows = items.map((item, index) => ({
    'Rad': index + 1,
    'Kund': item.customer,
    'Typ': item.type,
    'Kategori': item.categoryLabel,
    'Delivery- / Removalnummer': item.referenceNumber,
    'Streckkod': item.barcode || '-',
    'Antal': item.quantity,
    'Avläsningskvalitet':
      item.confidence === 'high' ? 'Hög' : item.confidence === 'medium' ? 'Normal' : 'Kontrollera',
    'Status': item.needsReview ? 'Behöver granskning' : 'Verifierad',
    'Tidpunkt i video': item.timestamps.join(', ') || '-',
    'Anteckning': item.notes || '',
  }));

  const summaryRows = summary.customerBreakdown.map((group) => ({
    'Kund': group.customer,
    'Delivery (antal kolli)': group.deliveryCount,
    'Removal (antal kolli)': group.removalCount,
    'Okänd typ': group.unknownCount,
    'Totalt antal kolli': group.totalCount,
  }));

  summaryRows.push({
    'Kund': 'TOTALT ALLA KUNDER',
    'Delivery (antal kolli)': summary.deliveryCount,
    'Removal (antal kolli)': summary.removalCount,
    'Okänd typ': summary.unknownCount,
    'Totalt antal kolli': summary.totalPackages,
  });

  const workbook = XLSX.utils.book_new();

  const inventorySheet = XLSX.utils.json_to_sheet(
    mainRows.length > 0
      ? mainRows
      : [
          {
            'Rad': '',
            'Kund': '',
            'Typ': '',
            'Kategori': '',
            'Delivery- / Removalnummer': '',
            'Streckkod': '',
            'Antal': '',
            'Avläsningskvalitet': '',
            'Status': '',
            'Tidpunkt i video': '',
            'Anteckning': `Inga rader i ${sessionTitle}`,
          },
        ]
  );

  inventorySheet['!cols'] = [
    { wch: 6 },
    { wch: 18 },
    { wch: 12 },
    { wch: 28 },
    { wch: 26 },
    { wch: 20 },
    { wch: 9 },
    { wch: 18 },
    { wch: 20 },
    { wch: 18 },
    { wch: 36 },
  ];

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  summarySheet['!cols'] = [
    { wch: 24 },
    { wch: 22 },
    { wch: 22 },
    { wch: 14 },
    { wch: 20 },
  ];

  XLSX.utils.book_append_sheet(workbook, inventorySheet, 'Inventering');
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Sammanfattning');

  return workbook;
}

export function getInventoryExcelBuffer(
  items: InventoryItem[],
  sessionTitle = 'Inventering'
): Uint8Array {
  const workbook = buildInventoryWorkbook(items, sessionTitle);
  const data = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(data as ArrayBuffer);
}

export function createExcelFileName(prefix = 'inventering'): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${prefix}-${stamp}.xlsx`;
}

export function downloadInventoryExcel(items: InventoryItem[], sessionTitle = 'Inventering'): string {
  const workbook = buildInventoryWorkbook(items, sessionTitle);
  const fileName = createExcelFileName('paketinventering');
  XLSX.writeFile(workbook, fileName);
  return fileName;
}
