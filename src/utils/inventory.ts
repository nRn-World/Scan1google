export type PackageType = 'Delivery' | 'Removal' | 'Okänd';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface RawDetectedPackage {
  customer?: string | null;
  type?: string | null;
  referenceNumber?: string | null;
  barcode?: string | null;
  quantity?: number | null;
  confidence?: string | null;
  timestamp?: string | null;
  notes?: string | null;
}

export interface InventoryItem {
  id: string;
  customer: string;
  type: PackageType;
  categoryLabel: string;
  referenceNumber: string;
  barcode: string;
  quantity: number;
  confidence: ConfidenceLevel;
  needsReview: boolean;
  timestamps: string[];
  notes: string;
  createdAt: string;
}

export interface CustomerGroupSummary {
  customer: string;
  deliveryCount: number;
  removalCount: number;
  unknownCount: number;
  totalCount: number;
}

export interface InventorySummary {
  totalPackages: number;
  uniqueCount: number;
  deliveryCount: number;
  removalCount: number;
  unknownCount: number;
  reviewNeededCount: number;
  customerBreakdown: CustomerGroupSummary[];
}

export interface ScanSession {
  id: string;
  title: string;
  createdAt: string;
  source: 'camera' | 'upload' | 'demo' | 'manual';
  items: InventoryItem[];
  summaryNote?: string;
}

const UPPERCASE_ACRONYMS = new Set([
  'IBM',
  'HP',
  'HPE',
  'DHL',
  'UPS',
  'TNT',
  'DSV',
  'ABB',
  'SAP',
  'BMW',
  'AWS',
  'GCP',
  'IT',
  'SE',
  'AB',
  'AS',
]);

export function normalizeCustomerName(raw?: string | null): string {
  const cleaned = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned || /^okänd\s+kund$/i.test(cleaned)) return 'Okänd kund';

  const words = cleaned.split(' ');
  const normalizedWords = words.map((word) => {
    const cleanWord = word.trim();
    if (!cleanWord) return '';
    const upper = cleanWord.toUpperCase();
    if (UPPERCASE_ACRONYMS.has(upper)) return upper;

    // Normalize ALL-CAPS or all-lowercase words to Title Case while preserving intentional camel/mixed brands
    const isAllUpper = cleanWord === cleanWord.toUpperCase() && /[A-ZÅÄÖ]/.test(cleanWord);
    const isAllLower = cleanWord === cleanWord.toLowerCase() && /[a-zåäö]/.test(cleanWord);
    if (isAllUpper || isAllLower) {
      return cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1).toLowerCase();
    }
    return cleanWord;
  });

  return normalizedWords.filter(Boolean).join(' ') || 'Okänd kund';
}

export function normalizeReferenceNumber(raw?: string | null): string {
  const cleaned = (raw ?? '').replace(/\s+/g, '').trim();
  return cleaned;
}

export function normalizeComparisonKey(value: string): string {
  return value.replace(/[\s\-_]+/g, '').toUpperCase();
}

export function inferPackageType(
  rawType?: string | null,
  referenceNumber?: string | null,
  notes?: string | null
): PackageType {
  const typeText = (rawType ?? '').trim().toLowerCase();
  if (typeText.includes('deliv') || typeText === 'del' || typeText.includes('inlev')) {
    return 'Delivery';
  }
  if (
    typeText.includes('remov') ||
    typeText === 'rem' ||
    typeText.includes('retur') ||
    typeText.includes('utlast')
  ) {
    return 'Removal';
  }

  const ref = (referenceNumber ?? '').trim();
  if (/^(DEL|DLV|INL)/i.test(ref)) return 'Delivery';
  if (/^(REM|RMV|RET|UTL)/i.test(ref)) return 'Removal';

  const noteText = (notes ?? '').toLowerCase();
  if (noteText.includes('delivery') || noteText.includes('inleverans')) return 'Delivery';
  if (noteText.includes('removal') || noteText.includes('retur')) return 'Removal';

  return 'Okänd';
}

export function normalizeConfidence(raw?: string | null): ConfidenceLevel {
  const val = (raw ?? '').trim().toLowerCase();
  if (val === 'high' || val === 'hög') return 'high';
  if (val === 'low' || val === 'låg') return 'low';
  return 'medium';
}

export function buildCategoryLabel(customer: string, type: PackageType): string {
  const cleanCustomer = normalizeCustomerName(customer);
  if (type === 'Okänd') {
    return cleanCustomer === 'Okänd kund' ? 'Okänd kategori' : `Kund ${cleanCustomer} (Okänd typ)`;
  }
  if (cleanCustomer === 'Okänd kund') {
    return `Okänd kund ${type}`;
  }
  return `Kund ${cleanCustomer} ${type}`;
}

export function createInventoryItem(
  raw: RawDetectedPackage,
  nowIso = new Date().toISOString()
): InventoryItem {
  const customer = normalizeCustomerName(raw.customer);
  const referenceNumber = normalizeReferenceNumber(raw.referenceNumber);
  const barcode = normalizeReferenceNumber(raw.barcode);
  const type = inferPackageType(raw.type, referenceNumber || barcode, raw.notes);
  const confidence = normalizeConfidence(raw.confidence);
  const quantity =
    typeof raw.quantity === 'number' && Number.isFinite(raw.quantity) && raw.quantity > 0
      ? Math.round(raw.quantity)
      : 1;
  const timestamp = (raw.timestamp ?? '').trim();
  const notes = (raw.notes ?? '').trim();
  const hasMissingIdentifier = !referenceNumber && !barcode;

  return {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `pkg-${Math.random().toString(36).slice(2, 11)}`,
    customer,
    type,
    categoryLabel: buildCategoryLabel(customer, type),
    referenceNumber: referenceNumber || barcode || 'SAKNAS',
    barcode,
    quantity,
    confidence,
    needsReview: confidence === 'low' || hasMissingIdentifier || type === 'Okänd',
    timestamps: timestamp ? [timestamp] : [],
    notes,
    createdAt: nowIso,
  };
}

function getDedupeKey(item: Pick<InventoryItem, 'customer' | 'type' | 'referenceNumber' | 'barcode'>): string {
  const customerKey = item.customer.trim().toLowerCase();
  const identifier =
    item.referenceNumber && item.referenceNumber !== 'SAKNAS'
      ? normalizeComparisonKey(item.referenceNumber)
      : normalizeComparisonKey(item.barcode);
  return `${customerKey}::${item.type}::${identifier}`;
}

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function mergeInventoryItems(
  existingItems: InventoryItem[],
  incomingRaw: RawDetectedPackage[],
  nowIso = new Date().toISOString()
): InventoryItem[] {
  const map = new Map<string, InventoryItem>();

  const upsert = (item: InventoryItem) => {
    const key = getDedupeKey(item);
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        ...item,
        categoryLabel: buildCategoryLabel(item.customer, item.type),
        timestamps: [...item.timestamps],
      });
      return;
    }

    const mergedTimestamps = Array.from(new Set([...current.timestamps, ...item.timestamps]));
    const worstConfidence =
      CONFIDENCE_RANK[current.confidence] <= CONFIDENCE_RANK[item.confidence]
        ? current.confidence
        : item.confidence;
    const mergedNotes = [current.notes, item.notes]
      .filter((note, idx, arr) => Boolean(note) && arr.indexOf(note) === idx)
      .join(' · ');

    map.set(key, {
      ...current,
      barcode: current.barcode || item.barcode,
      quantity: current.quantity + item.quantity,
      confidence: worstConfidence,
      needsReview: current.needsReview || item.needsReview || worstConfidence === 'low',
      timestamps: mergedTimestamps,
      notes: mergedNotes,
    });
  };

  for (const item of existingItems) {
    upsert(item);
  }
  for (const raw of incomingRaw) {
    const item = createInventoryItem(raw, nowIso);
    upsert(item);
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.customer !== b.customer) return a.customer.localeCompare(b.customer, 'sv');
    if (a.type !== b.type) return a.type.localeCompare(b.type, 'sv');
    return a.referenceNumber.localeCompare(b.referenceNumber, 'sv');
  });
}

export function recalculateItemMetadata(item: InventoryItem): InventoryItem {
  const customer = normalizeCustomerName(item.customer);
  const referenceNumber = normalizeReferenceNumber(item.referenceNumber) || 'SAKNAS';
  const barcode = normalizeReferenceNumber(item.barcode);
  const categoryLabel = buildCategoryLabel(customer, item.type);
  const needsReview =
    item.confidence === 'low' || referenceNumber === 'SAKNAS' || item.type === 'Okänd';

  return {
    ...item,
    customer,
    referenceNumber,
    barcode,
    categoryLabel,
    needsReview,
    quantity: Math.max(1, Math.round(item.quantity || 1)),
  };
}

export function calculateInventorySummary(items: InventoryItem[]): InventorySummary {
  let totalPackages = 0;
  let deliveryCount = 0;
  let removalCount = 0;
  let unknownCount = 0;
  let reviewNeededCount = 0;

  const customerMap = new Map<string, CustomerGroupSummary>();

  for (const item of items) {
    const qty = Math.max(0, item.quantity);
    totalPackages += qty;
    if (item.type === 'Delivery') deliveryCount += qty;
    else if (item.type === 'Removal') removalCount += qty;
    else unknownCount += qty;

    if (item.needsReview) reviewNeededCount += 1;

    const existing = customerMap.get(item.customer) ?? {
      customer: item.customer,
      deliveryCount: 0,
      removalCount: 0,
      unknownCount: 0,
      totalCount: 0,
    };

    if (item.type === 'Delivery') existing.deliveryCount += qty;
    else if (item.type === 'Removal') existing.removalCount += qty;
    else existing.unknownCount += qty;
    existing.totalCount += qty;

    customerMap.set(item.customer, existing);
  }

  const customerBreakdown = Array.from(customerMap.values()).sort(
    (a, b) => b.totalCount - a.totalCount || a.customer.localeCompare(b.customer, 'sv')
  );

  return {
    totalPackages,
    uniqueCount: items.length,
    deliveryCount,
    removalCount,
    unknownCount,
    reviewNeededCount,
    customerBreakdown,
  };
}

export function formatInventoryAsNotepadText(
  items: InventoryItem[],
  sessionTitle = 'Inventeringslista',
  generatedAt = new Date()
): string {
  const summary = calculateInventorySummary(items);
  const dateStr = generatedAt.toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  if (items.length === 0) {
    return `${sessionTitle.toUpperCase()} — ${dateStr}\nInga paket registrerade ännu.`;
  }

  const lines: string[] = [
    `${sessionTitle.toUpperCase()} — ${dateStr}`,
    `Totalt: ${summary.totalPackages} st kolli (${summary.uniqueCount} unika nummer)`,
    `Delivery: ${summary.deliveryCount} st  |  Removal: ${summary.removalCount} st${
      summary.unknownCount > 0 ? `  |  Okänd typ: ${summary.unknownCount} st` : ''
    }`,
    '='.repeat(64),
    '',
  ];

  // Group by categoryLabel (e.g., "Kund Microsoft Delivery")
  const groups = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const list = groups.get(item.categoryLabel) ?? [];
    list.push(item);
    groups.set(item.categoryLabel, list);
  }

  for (const [category, groupItems] of groups.entries()) {
    const groupTotal = groupItems.reduce((sum, item) => sum + item.quantity, 0);
    lines.push(`${category.toUpperCase()} (${groupTotal} st)`);
    lines.push('-'.repeat(64));
    for (const item of groupItems) {
      const barcodePart =
        item.barcode && item.barcode !== item.referenceNumber
          ? `  |  Streckkod: ${item.barcode}`
          : '';
      const reviewFlag = item.needsReview ? '  [KONTROLLERA]' : '';
      lines.push(
        `• ${item.referenceNumber}  |  Antal: ${item.quantity} st  |  Kategori: ${item.categoryLabel}${barcodePart}${reviewFlag}`
      );
      if (item.notes) {
        lines.push(`  Notering: ${item.notes}`);
      }
    }
    lines.push('');
  }

  lines.push('='.repeat(64));
  lines.push('SNABBKOPIERING (TAB-SEPARERAD FÖR SYSTEM / EXCEL):');
  lines.push('Kund\tTyp\tKategori\tNummer\tStreckkod\tAntal');
  for (const item of items) {
    lines.push(
      `${item.customer}\t${item.type}\t${item.categoryLabel}\t${item.referenceNumber}\t${
        item.barcode || '-'
      }\t${item.quantity}`
    );
  }

  return lines.join('\n');
}

export const DEMO_RAW_PACKAGES: RawDetectedPackage[] = [
  {
    customer: 'Microsoft',
    type: 'Delivery',
    referenceNumber: 'Del001234567',
    barcode: '7310012345678',
    quantity: 1,
    confidence: 'high',
    timestamp: '00:02',
  },
  {
    customer: 'Microsoft',
    type: 'Delivery',
    referenceNumber: 'Del001234567',
    barcode: '7310012345678',
    quantity: 1,
    confidence: 'high',
    timestamp: '00:05',
    notes: 'Två kolli med samma deliverynummer identifierade efter varandra',
  },
  {
    customer: 'Microsoft',
    type: 'Removal',
    referenceNumber: 'Rem004891203',
    barcode: '7310048912034',
    quantity: 1,
    confidence: 'high',
    timestamp: '00:09',
  },
  {
    customer: 'Google',
    type: 'Delivery',
    referenceNumber: 'Del008912450',
    barcode: '7350089124501',
    quantity: 3,
    confidence: 'high',
    timestamp: '00:14',
  },
  {
    customer: 'Amazon',
    type: 'Removal',
    referenceNumber: 'Rem007721094',
    barcode: '7350077210948',
    quantity: 1,
    confidence: 'medium',
    timestamp: '00:19',
  },
  {
    customer: 'DHL',
    type: 'Delivery',
    referenceNumber: 'Del005519820',
    barcode: '00373125519820',
    quantity: 1,
    confidence: 'low',
    timestamp: '00:24',
    notes: 'Etiketten delvis repad vid sista siffran, kontrollera 0',
  },
];
