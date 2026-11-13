import {
  inferPackageType,
  normalizeComparisonKey,
  normalizeCustomerName,
  type ConfidenceLevel,
  type PackageType,
  type RawDetectedPackage,
} from './inventory';

export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedBarcodeRead {
  text: string;
  format: string;
  rotation?: number;
  position?: BoundingRect;
}

export interface OcrLineBox {
  text: string;
  confidence: number; // 0..100
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export interface FrameAnalysisInput {
  frameIndex: number;
  timestampSec?: number;
  sourceKind: 'video-frame' | 'image';
  barcodes: DetectedBarcodeRead[];
  ocrText: string;
  ocrConfidence: number; // 0..100
  ocrLines?: OcrLineBox[];
  hint?: string;
}

interface ExtractedRefCandidate {
  referenceNumber: string;
  impliedType: PackageType;
  confidence: ConfidenceLevel;
  note?: string;
  centerY?: number;
  centerX?: number;
  lineIndex?: number;
}

interface BrandPattern {
  canonical: string;
  regex: RegExp;
  isCarrier?: boolean;
}

const BRAND_PATTERNS: BrandPattern[] = [
  // Enterprise / Tech / Nordic Customers (higher priority than carriers)
  { canonical: 'Microsoft', regex: /\bM[i1l|]cros[o0]ft(?:\s+Corp(?:oration)?)?\b/i },
  { canonical: 'Google', regex: /\bG[o0]{2}g[l1i]e(?:\s+Cloud)?\b/i },
  { canonical: 'Amazon', regex: /\bAmaz[o0]n(?:\s+Web\s+Services)?\b/i },
  { canonical: 'AWS', regex: /\bAWS\b/ },
  { canonical: 'Apple', regex: /\bApp[l1]e(?:\s+Inc)?\b/i },
  { canonical: 'Meta', regex: /\bMeta(?:\s+Platforms)?\b/i },
  { canonical: 'IBM', regex: /\bIBM\b/ },
  { canonical: 'HPE', regex: /\b(?:HPE|Hewlett\s+Packard\s+Enterprise)\b/i },
  { canonical: 'HP', regex: /\b(?:HP\s+Inc|Hewlett[\s-]Packard|\bHP\b)/i },
  { canonical: 'Dell', regex: /\bDe[l1]{2}\s+Techn[o0]l[o0]gies\b|\bDell\b/i },
  { canonical: 'Lenovo', regex: /\bLen[o0]v[o0]\b/i },
  { canonical: 'Cisco', regex: /\bCisc[o0]\b/i },
  { canonical: 'Oracle', regex: /\bOrac[l1]e\b/i },
  { canonical: 'SAP', regex: /\bSAP\b/ },
  { canonical: 'Nvidia', regex: /\bNvid[i1]a\b/i },
  { canonical: 'Intel', regex: /\bInte[l1]\b/i },
  { canonical: 'AMD', regex: /\bAMD\b/ },
  { canonical: 'Samsung', regex: /\bSamsung\b/i },
  { canonical: 'Sony', regex: /\bS[o0]ny\b/i },
  { canonical: 'Ericsson', regex: /\bEricss[o0]n\b/i },
  { canonical: 'Nokia', regex: /\bN[o0]k[i1]a\b/i },
  { canonical: 'Telia', regex: /\bTe[l1]ia(?:\s+Company)?\b/i },
  { canonical: 'Tele2', regex: /\bTe[l1]e\s*2\b/i },
  { canonical: 'Telenor', regex: /\bTe[l1]en[o0]r\b/i },
  { canonical: 'ABB', regex: /\bABB\b/ },
  { canonical: 'Volvo', regex: /\bV[o0]lv[o0]\b/i },
  { canonical: 'Scania', regex: /\bScan[i1]a\b/i },
  { canonical: 'Atlas Copco', regex: /\bAtlas\s+C[o0]pc[o0]\b/i },
  { canonical: 'IKEA', regex: /\bIKEA\b/i },
  { canonical: 'Spotify', regex: /\bSp[o0]tify\b/i },
  { canonical: 'Klarna', regex: /\bK[l1]arna\b/i },
  { canonical: 'Vattenfall', regex: /\bVattenfa[l1]{2}\b/i },
  { canonical: 'AstraZeneca', regex: /\bAstra\s*Zeneca\b/i },
  { canonical: 'SKF', regex: /\bSKF\b/ },
  { canonical: 'Sandvik', regex: /\bSandv[i1]k\b/i },
  { canonical: 'Electrolux', regex: /\bE[l1]ectr[o0]lux\b/i },
  { canonical: 'Husqvarna', regex: /\bHusqvarna\b/i },
  { canonical: 'Securitas', regex: /\bSecur[i1]tas\b/i },
  { canonical: 'Saab', regex: /\bSAAB\b/i },
  { canonical: 'Equinix', regex: /\bEqu[i1]n[i1]x\b/i },
  { canonical: 'Digital Realty', regex: /\bDigital\s+Realty\b/i },
  { canonical: 'Conapto', regex: /\bC[o0]napt[o0]\b/i },
  { canonical: 'Bahnhof', regex: /\bBahnh[o0]f\b/i },
  { canonical: 'GlobalConnect', regex: /\bGlobal\s*Connect\b/i },
  { canonical: 'Atea', regex: /\bAtea\b/i },
  { canonical: 'Dustin', regex: /\bDust[i1]n\b/i },
  { canonical: 'Advania', regex: /\bAdvan[i1]a\b/i },
  { canonical: 'Inrego', regex: /\bInreg[o0]\b/i },

  // Logistics / Freight Carriers (used when no separate end-customer is printed)
  { canonical: 'DHL', regex: /\bDHL(?:\s+Express|\s+Freight|\s+Parcel)?\b/i, isCarrier: true },
  { canonical: 'PostNord', regex: /\bP[o0]st\s*N[o0]rd\b/i, isCarrier: true },
  { canonical: 'DB Schenker', regex: /\b(?:DB\s+)?Schenker\b/i, isCarrier: true },
  { canonical: 'UPS', regex: /\bUPS\b/, isCarrier: true },
  { canonical: 'FedEx', regex: /\bFed\s*Ex\b/i, isCarrier: true },
  { canonical: 'DSV', regex: /\bDSV\b/, isCarrier: true },
  { canonical: 'Bring', regex: /\bBring\b/i, isCarrier: true },
  { canonical: 'TNT', regex: /\bTNT\b/, isCarrier: true },
  { canonical: 'GLS', regex: /\bGLS\b/, isCarrier: true },
  { canonical: 'Budbee', regex: /\bBudbee\b/i, isCarrier: true },
  { canonical: 'Instabox', regex: /\bInstab[o0]x\b/i, isCarrier: true },
];

const STOPWORD_CUSTOMER_TOKENS = new Set([
  'delivery',
  'removal',
  'inleverans',
  'utlastning',
  'retur',
  'return',
  'inbound',
  'outbound',
  'package',
  'paket',
  'kolli',
  'pallet',
  'pall',
  'weight',
  'vikt',
  'date',
  'datum',
  'from',
  'från',
  'sweden',
  'sverige',
  'stockholm',
  'göteborg',
  'malmö',
  'kista',
  'warehouse',
  'lager',
  'barcode',
  'streckkod',
  'reference',
  'referens',
  'order',
  'shipment',
  'tracking',
  'quantity',
  'antal',
  'endast',
  'bara',
]);

export function formatTimestampSec(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function cleanBarcodeValue(raw: string): string {
  if (!raw) return '';
  // Remove ISO/IEC 15424 symbology identifiers such as ]C1, ]d2, ]Q1, ]E0 and control chars
  let cleaned = raw
    .replace(/^\][A-Za-z][0-9]/, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();

  // If GS1 HRI format like "(00) 373125519820123456" with only digits/spaces/parens, flatten digits
  if (/^\(\d{2,4}\)[\d\s()]+$/.test(cleaned)) {
    cleaned = cleaned.replace(/[()\s]+/g, '');
  }

  return cleaned.trim();
}

function isReferenceLikeCode(code: string): boolean {
  const compact = code.replace(/[\s\-_]+/g, '');
  return /^(DEL|DLV|INL|REM|RMV|RET|UTL|ORD|SHP|RITM|INC|CHG)[A-Z0-9]{3,24}$/i.test(compact);
}

function normalizeDelRemPrefixAndTail(
  rawPrefix: string,
  rawTail: string
): { normalized: string; impliedType: PackageType; repairedAmbiguous: boolean; prefixRepaired: boolean } {
  const upperPrefix = rawPrefix.toUpperCase();
  let canonicalPrefix = rawPrefix;
  let impliedType: PackageType = 'Okänd';
  let prefixRepaired = false;

  if (/^DE[1I|]$/i.test(rawPrefix) || /^0EL$/i.test(rawPrefix)) {
    canonicalPrefix = 'Del';
    impliedType = 'Delivery';
    prefixRepaired = true;
  } else if (/^RE(?:RN|N)$/i.test(rawPrefix)) {
    canonicalPrefix = 'Rem';
    impliedType = 'Removal';
    prefixRepaired = true;
  } else if (upperPrefix === 'DEL' || upperPrefix === 'DELIVERY') {
    canonicalPrefix = 'Del';
    impliedType = 'Delivery';
  } else if (upperPrefix === 'DLV' || upperPrefix === 'INL') {
    canonicalPrefix = upperPrefix;
    impliedType = 'Delivery';
  } else if (upperPrefix === 'REM' || upperPrefix === 'REMOVAL') {
    canonicalPrefix = 'Rem';
    impliedType = 'Removal';
  } else if (upperPrefix === 'RMV' || upperPrefix === 'RET' || upperPrefix === 'UTL') {
    canonicalPrefix = upperPrefix;
    impliedType = 'Removal';
  }

  const compactTail = rawTail.replace(/[\s\-_:]+/g, '');
  const digitCount = (compactTail.match(/\d/g) ?? []).length;
  const mostlyNumeric = compactTail.length >= 4 && digitCount / compactTail.length >= 0.7;

  let repairedAmbiguous = false;
  let fixedTail = compactTail;

  if (mostlyNumeric) {
    fixedTail = compactTail
      .split('')
      .map((ch) => {
        if (ch === 'O' || ch === 'o') return '0';
        if (ch === 'I' || ch === 'l' || ch === '|') return '1';
        if (ch === 'S' || ch === 's') {
          repairedAmbiguous = true;
          return '5';
        }
        if (ch === 'B') {
          repairedAmbiguous = true;
          return '8';
        }
        return ch;
      })
      .join('');
  }

  return {
    normalized: `${canonicalPrefix}${fixedTail}`,
    impliedType,
    repairedAmbiguous,
    prefixRepaired,
  };
}

function cleanExplicitCustomerCandidate(raw: string): string | null {
  const trimmed = raw
    .replace(/^[:#\-–—.\s]+/, '')
    .split(/[|;/\\]/)[0]
    .replace(/\b(?:Delivery|Removal|Inleverans|Retur|Utlastning|Del\d+|Rem\d+)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!trimmed || trimmed.length < 2 || trimmed.length > 42) return null;
  if (/^\d+$/.test(trimmed)) return null;
  if (/^(del|rem|dlv|rmv|inl|ret)\d/i.test(trimmed)) return null;

  const words = trimmed.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  if (words.every((w) => STOPWORD_CUSTOMER_TOKENS.has(w.toLowerCase()))) return null;

  return normalizeCustomerName(trimmed);
}

export function extractCustomerFromText(
  ocrText: string,
  ocrLines?: OcrLineBox[],
  hint?: string
): string {
  const lines =
    ocrLines && ocrLines.length > 0
      ? ocrLines.map((l) => l.text.trim()).filter(Boolean)
      : ocrText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

  // Tier 1: Explicit "Kund: ...", "Customer: ...", "Client: ...", "Mottagare: ...", "Ship To: ..."
  const explicitFieldRegex =
    /(?:^|\b)(?:Kund|Customer|Client|Mottagare|Beställare|Ship\s*To|Deliver\s*To|Consignee|Account|Företag|Uppdragsgivare)\s*[:#\-]\s*([A-Za-zÅÄÖåäö0-9&.\- ]{2,40})/i;

  for (const line of lines) {
    const match = line.match(explicitFieldRegex);
    if (match?.[1]) {
      // Check if known brand is inside the explicit field first
      for (const brand of BRAND_PATTERNS) {
        if (brand.regex.test(match[1])) {
          return brand.canonical;
        }
      }
      const cleaned = cleanExplicitCustomerCandidate(match[1]);
      if (cleaned && cleaned !== 'Okänd kund') {
        return cleaned;
      }
    }
  }

  const combinedText = lines.join('\n');

  // Tier 2a: Known Enterprise Customer Brands (prioritized over shipping carriers)
  for (const brand of BRAND_PATTERNS) {
    if (!brand.isCarrier && brand.regex.test(combinedText)) {
      return brand.canonical;
    }
  }

  // Tier 3a: Company name with corporate legal suffix (e.g. "Nordic Datacenter AB", "Acme Corp")
  const legalSuffixRegex =
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&\-]{1,20}(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&\-]{1,20}){0,2}\s+(?:AB|AS|A\/S|Oy|Inc\.?|Ltd\.?|GmbH|Corp\.?|Group|Systems|Logistics|Cloud))\b/;
  for (const line of lines) {
    const match = line.match(legalSuffixRegex);
    if (match?.[1]) {
      const candidate = cleanExplicitCustomerCandidate(match[1]);
      if (candidate && candidate !== 'Okänd kund') {
        return candidate;
      }
    }
  }

  // Tier 2b: Logistics Carrier Brands (e.g. DHL, PostNord, UPS, DB Schenker)
  for (const brand of BRAND_PATTERNS) {
    if (brand.isCarrier && brand.regex.test(combinedText)) {
      return brand.canonical;
    }
  }

  // Tier 3b: Prominent clean header line at top of label (e.g. a standalone brand name on line 1-2)
  for (const line of lines.slice(0, 3)) {
    const cleanLine = line.replace(/[^A-Za-zÅÄÖåäö0-9& \-]/g, '').trim();
    if (
      cleanLine.length >= 3 &&
      cleanLine.length <= 24 &&
      !/\d{3,}/.test(cleanLine) &&
      !/^(delivery|removal|inleverans|retur|utlastning|kolli|paket|fraktsedel|shipping|label)$/i.test(
        cleanLine
      )
    ) {
      const candidate = cleanExplicitCustomerCandidate(cleanLine);
      if (candidate && candidate !== 'Okänd kund') {
        return candidate;
      }
    }
  }

  // Tier 4: User-provided hint fallback (e.g. "Endast Microsoft Delivery" or "Volvo")
  if (hint && hint.trim()) {
    const cleanHint = hint.trim();
    for (const brand of BRAND_PATTERNS) {
      if (brand.regex.test(cleanHint)) {
        return brand.canonical;
      }
    }
    const strippedHint = cleanHint
      .replace(/\b(?:endast|bara|only|delivery|removal|inleverans|retur|pall\s*\d+|kund)\b/gi, ' ')
      .replace(/[:#\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hintCustomer = cleanExplicitCustomerCandidate(strippedHint);
    if (hintCustomer && hintCustomer !== 'Okänd kund') {
      return hintCustomer;
    }
  }

  return 'Okänd kund';
}

export function extractReferenceCandidates(
  ocrText: string,
  ocrLines?: OcrLineBox[],
  overallConfidence = 80
): ExtractedRefCandidate[] {
  const lines: OcrLineBox[] =
    ocrLines && ocrLines.length > 0
      ? ocrLines
      : ocrText.split(/\r?\n/).map((text) => ({
          text,
          confidence: overallConfidence,
        }));

  const found: ExtractedRefCandidate[] = [];
  const seenKeys = new Set<string>();

  const addCandidate = (cand: ExtractedRefCandidate) => {
    const key = normalizeComparisonKey(cand.referenceNumber);
    if (!key || key.length < 4) return;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    found.push(cand);
  };

  // Pass 1: Direct Del / Rem / DLV / RMV / INL / RET / UTL reference codes
  const directPrefixRegex =
    /\b(Del|DEL|DLV|INL|Rem|REM|RMV|RET|UTL|De[1I|]|0el|Re(?:rn|m))[\s\-_:]*([0-9][0-9OIoIl|SB\s\-]{3,22})\b/g;

  lines.forEach((lineObj, idx) => {
    const lineText = lineObj.text;
    if (!lineText || !lineText.trim()) return;

    const lineConf = typeof lineObj.confidence === 'number' ? lineObj.confidence : overallConfidence;
    const centerY = lineObj.bbox ? (lineObj.bbox.y0 + lineObj.bbox.y1) / 2 : undefined;
    const centerX = lineObj.bbox ? (lineObj.bbox.x0 + lineObj.bbox.x1) / 2 : undefined;

    for (const match of lineText.matchAll(directPrefixRegex)) {
      const rawPrefix = match[1];
      // Stop capture before trailing words if spaces were matched
      const rawTailChunk = match[2].trim().split(/\s+(?=[A-Za-z]{2,})/)[0];
      const compactCheck = rawTailChunk.replace(/[\s\-]+/g, '');
      if (compactCheck.length < 4 || compactCheck.length > 20) continue;

      // For OCR prefix repairs like De1..., require leading 0 and >=5 chars to avoid German VAT etc.
      if (/^(De[1I|]|0el|Rern)$/i.test(rawPrefix) && !/^0[\dOIoIl|]{4,}$/.test(compactCheck)) {
        continue;
      }

      const { normalized, impliedType, repairedAmbiguous, prefixRepaired } =
        normalizeDelRemPrefixAndTail(rawPrefix, compactCheck);

      let confidence: ConfidenceLevel =
        lineConf >= 78 ? 'high' : lineConf >= 55 ? 'medium' : 'low';
      const notes: string[] = [];

      if (repairedAmbiguous || prefixRepaired) {
        confidence = lineConf >= 70 ? 'medium' : 'low';
        notes.push('Kontrollera tecken (OCR-korrigerad etikett)');
      } else if (confidence === 'low') {
        notes.push('Låg bildskärpa vid avläsning — kontrollera numret');
      }

      addCandidate({
        referenceNumber: normalized,
        impliedType,
        confidence,
        note: notes.join(' · '),
        centerY,
        centerX,
        lineIndex: idx,
      });
    }

    // Pass 1b: "Delivery Nr: 001234567" / "Removal ID: 004891203" where number lacks Del/Rem prefix
    const labeledDelRemRegex =
      /\b(Delivery|Inleverans|Removal|Retur|Utlastning)\s*(?:nr|no|num(?:ber|mer)?|id|ref|#|:)[\s.:\-#]*([A-Z0-9][A-Z0-9\-]{4,20})\b/gi;
    for (const match of lineText.matchAll(labeledDelRemRegex)) {
      const keyword = match[1];
      const rawCode = match[2].trim();
      if (/^(delivery|removal|kund|customer)$/i.test(rawCode)) continue;
      const impliedType = inferPackageType(keyword, rawCode);
      const hasPrefixAlready = /^(del|dlv|inl|rem|rmv|ret|utl)/i.test(rawCode);
      const formattedRef = hasPrefixAlready
        ? normalizeDelRemPrefixAndTail(rawCode.slice(0, 3), rawCode.slice(3)).normalized
        : impliedType === 'Delivery' && /^\d{5,}$/.test(rawCode)
          ? `Del${rawCode}`
          : impliedType === 'Removal' && /^\d{5,}$/.test(rawCode)
            ? `Rem${rawCode}`
            : rawCode;

      addCandidate({
        referenceNumber: formattedRef,
        impliedType,
        confidence: lineConf >= 75 ? 'high' : lineConf >= 52 ? 'medium' : 'low',
        centerY,
        centerX,
        lineIndex: idx,
      });
    }
  });

  if (found.length > 0) {
    return found;
  }

  // Pass 2: Secondary warehouse reference numbers (Ref, Order, Shipment, Kolli-ID, PO, RITM, INC)
  const genericRefRegex =
    /\b(?:Ref(?:erens|erence)?|Order(?:\s*nr|\s*no|\s*id)?|Shipment(?:\s*ID)?|Kolli(?:\s*-?\s*ID|\s*nr)?|Sändnings(?:-?id|nr)|PO|SO)\s*[:#.]+\s*([A-Z0-9][A-Z0-9\-_]{4,22})\b/gi;
  const ticketRegex = /\b((?:RITM|INC|CHG|SCTASK|SHP|ORD)[0-9]{5,14})\b/g;

  lines.forEach((lineObj, idx) => {
    const lineText = lineObj.text;
    const lineConf = typeof lineObj.confidence === 'number' ? lineObj.confidence : overallConfidence;
    const centerY = lineObj.bbox ? (lineObj.bbox.y0 + lineObj.bbox.y1) / 2 : undefined;
    const centerX = lineObj.bbox ? (lineObj.bbox.x0 + lineObj.bbox.x1) / 2 : undefined;

    for (const match of lineText.matchAll(genericRefRegex)) {
      const code = match[1].trim();
      if (/\d/.test(code)) {
        addCandidate({
          referenceNumber: code,
          impliedType: inferPackageType(undefined, code, lineText),
          confidence: lineConf >= 78 ? 'high' : lineConf >= 55 ? 'medium' : 'low',
          centerY,
          centerX,
          lineIndex: idx,
        });
      }
    }

    for (const match of lineText.matchAll(ticketRegex)) {
      addCandidate({
        referenceNumber: match[1],
        impliedType: inferPackageType(undefined, match[1], lineText),
        confidence: lineConf >= 78 ? 'high' : 'medium',
        centerY,
        centerX,
        lineIndex: idx,
      });
    }
  });

  return found;
}

function parseStructuredBarcodePayload(text: string): Partial<RawDetectedPackage> | null {
  const trimmed = text.trim();

  // JSON QR Code payload
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const ref =
        (typeof obj.referenceNumber === 'string' && obj.referenceNumber) ||
        (typeof obj.ref === 'string' && obj.ref) ||
        (typeof obj.deliveryNumber === 'string' && obj.deliveryNumber) ||
        (typeof obj.removalNumber === 'string' && obj.removalNumber) ||
        (typeof obj.id === 'string' && obj.id) ||
        '';
      const customer =
        (typeof obj.customer === 'string' && obj.customer) ||
        (typeof obj.kund === 'string' && obj.kund) ||
        (typeof obj.client === 'string' && obj.client) ||
        undefined;
      const type =
        (typeof obj.type === 'string' && obj.type) ||
        (typeof obj.typ === 'string' && obj.typ) ||
        undefined;
      const barcode = typeof obj.barcode === 'string' ? obj.barcode : undefined;
      const quantity = typeof obj.quantity === 'number' ? obj.quantity : 1;

      if (ref || barcode) {
        return {
          customer,
          type,
          referenceNumber: ref || barcode,
          barcode,
          quantity,
          confidence: 'high',
        };
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  // Multi-part QR / DataMatrix text with key-values or pipe separators containing Del/Rem
  if (/[|\n;]/.test(trimmed)) {
    const refs = extractReferenceCandidates(trimmed, undefined, 95);
    const customer = extractCustomerFromText(trimmed);
    const type = inferPackageType(trimmed, refs[0]?.referenceNumber, trimmed);
    if (refs.length > 0 || customer !== 'Okänd kund') {
      return {
        customer: customer !== 'Okänd kund' ? customer : undefined,
        type: type !== 'Okänd' ? type : undefined,
        referenceNumber: refs[0]?.referenceNumber,
        confidence: 'high',
      };
    }
  }

  return null;
}

interface DeduplicatedBarcodeGroup {
  text: string;
  format: string;
  distinctPhysicalCount: number;
  centers: Array<{ x: number; y: number }>;
}

function groupFrameBarcodes(barcodes: DetectedBarcodeRead[]): DeduplicatedBarcodeGroup[] {
  const groups = new Map<string, DeduplicatedBarcodeGroup>();

  for (const rawBc of barcodes) {
    const cleaned = cleanBarcodeValue(rawBc.text);
    if (!cleaned || cleaned.length < 4) continue;

    const key = normalizeComparisonKey(cleaned);
    const pos = rawBc.position;
    const center = pos
      ? { x: pos.x + pos.width / 2, y: pos.y + pos.height / 2 }
      : undefined;
    const span = pos ? Math.max(pos.width, pos.height, 48) : 80;

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        text: cleaned,
        format: rawBc.format,
        distinctPhysicalCount: 1,
        centers: center ? [center] : [],
      });
      continue;
    }

    // Check if this barcode read is at a genuinely separated physical position in the same frame
    if (center && existing.centers.length > 0) {
      const isFarFromAll = existing.centers.every((c) => {
        const dist = Math.hypot(c.x - center.x, c.y - center.y);
        return dist > Math.max(60, span * 0.85);
      });
      if (isFarFromAll) {
        existing.distinctPhysicalCount += 1;
        existing.centers.push(center);
      }
    }
  }

  return Array.from(groups.values());
}

function extractPrintedNumericBarcodeFallback(ocrText: string): string {
  // Matches EAN-13, EAN-14, SSCC-18, or 10-20 digit barcode numbers printed beneath bars
  const compactLines = ocrText.split(/\r?\n/);
  for (const line of compactLines) {
    const trimmed = line.trim();
    // e.g. "7 310012 345678" or "7310012345678" or "00373125519820"
    if (/^\d[\d\s]{9,22}\d$/.test(trimmed)) {
      const digits = trimmed.replace(/\s+/g, '');
      if (digits.length >= 10 && digits.length <= 22) {
        return digits;
      }
    }
  }
  return '';
}

export function parseLabelFrame(input: FrameAnalysisInput): RawDetectedPackage[] {
  const timestamp = formatTimestampSec(input.timestampSec);
  const barcodeGroups = groupFrameBarcodes(input.barcodes);
  const ocrRefs = extractReferenceCandidates(
    input.ocrText,
    input.ocrLines,
    input.ocrConfidence
  );

  const globalCustomer = extractCustomerFromText(input.ocrText, input.ocrLines, input.hint);
  const globalType = inferPackageType(input.ocrText, undefined, input.hint);

  const results: RawDetectedPackage[] = [];
  const usedBarcodeKeys = new Set<string>();

  // 1. Check structured 2D QR/DataMatrix payloads first
  for (const bc of barcodeGroups) {
    const structured = parseStructuredBarcodePayload(bc.text);
    if (structured && structured.referenceNumber) {
      usedBarcodeKeys.add(normalizeComparisonKey(bc.text));
      const resolvedType = inferPackageType(
        structured.type ?? globalType,
        structured.referenceNumber,
        input.hint
      );
      results.push({
        customer: structured.customer ?? globalCustomer,
        type: resolvedType,
        referenceNumber: structured.referenceNumber,
        barcode: structured.barcode ?? '',
        quantity: bc.distinctPhysicalCount * (structured.quantity ?? 1),
        confidence: 'high',
        timestamp: timestamp || undefined,
      });
    }
  }

  // Separate remaining barcodes into reference-encoding barcodes vs numeric/tracking barcodes
  const refBarcodes = barcodeGroups.filter(
    (b) => !usedBarcodeKeys.has(normalizeComparisonKey(b.text)) && isReferenceLikeCode(b.text)
  );
  const trackingBarcodes = barcodeGroups.filter(
    (b) => !usedBarcodeKeys.has(normalizeComparisonKey(b.text)) && !isReferenceLikeCode(b.text)
  );

  // Merge reference barcodes with OCR reference candidates so barcode-verified refs upgrade confidence to 'high'
  const mergedRefs: Array<{
    referenceNumber: string;
    impliedType: PackageType;
    confidence: ConfidenceLevel;
    quantity: number;
    note?: string;
    centerY?: number;
    centerX?: number;
  }> = [];

  for (const rb of refBarcodes) {
    const prefixMatch = rb.text.match(/^([A-Za-z]+)[\s\-_]*(.+)$/);
    const formatted = prefixMatch
      ? normalizeDelRemPrefixAndTail(prefixMatch[1], prefixMatch[2]).normalized
      : rb.text;
    usedBarcodeKeys.add(normalizeComparisonKey(rb.text));
    mergedRefs.push({
      referenceNumber: formatted,
      impliedType: inferPackageType(undefined, formatted, input.ocrText),
      confidence: 'high',
      quantity: rb.distinctPhysicalCount,
      centerX: rb.centers[0]?.x,
      centerY: rb.centers[0]?.y,
    });
  }

  for (const ocrRef of ocrRefs) {
    const key = normalizeComparisonKey(ocrRef.referenceNumber);
    const existing = mergedRefs.find(
      (m) => normalizeComparisonKey(m.referenceNumber) === key
    );
    if (!existing) {
      mergedRefs.push({
        referenceNumber: ocrRef.referenceNumber,
        impliedType: ocrRef.impliedType,
        confidence: ocrRef.confidence,
        quantity: 1,
        note: ocrRef.note,
        centerX: ocrRef.centerX,
        centerY: ocrRef.centerY,
      });
    }
  }

  // 2. Build packages from merged reference numbers, pairing each with closest tracking barcode
  if (mergedRefs.length > 0) {
    const availableTracking = [...trackingBarcodes];

    for (const ref of mergedRefs) {
      let pairedBarcode = '';
      let pairedCount = ref.quantity;

      if (availableTracking.length === 1 && mergedRefs.length === 1) {
        const tb = availableTracking.shift()!;
        pairedBarcode = tb.text;
        pairedCount = Math.max(pairedCount, tb.distinctPhysicalCount);
        usedBarcodeKeys.add(normalizeComparisonKey(tb.text));
      } else if (
        availableTracking.length > 0 &&
        ref.centerY !== undefined
      ) {
        let bestIdx = -1;
        let bestDist = Infinity;
        availableTracking.forEach((tb, idx) => {
          if (tb.centers.length > 0) {
            const dist = Math.hypot(
              (tb.centers[0].x ?? 0) - (ref.centerX ?? 0),
              tb.centers[0].y - ref.centerY!
            );
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = idx;
            }
          }
        });
        if (bestIdx >= 0) {
          const [tb] = availableTracking.splice(bestIdx, 1);
          pairedBarcode = tb.text;
          pairedCount = Math.max(pairedCount, tb.distinctPhysicalCount);
          usedBarcodeKeys.add(normalizeComparisonKey(tb.text));
        }
      }

      if (!pairedBarcode && mergedRefs.length === 1) {
        pairedBarcode = extractPrintedNumericBarcodeFallback(input.ocrText);
      }

      const resolvedType =
        ref.impliedType !== 'Okänd'
          ? ref.impliedType
          : globalType !== 'Okänd'
            ? globalType
            : inferPackageType(undefined, ref.referenceNumber, input.hint);

      // Barcode pairing boosts medium OCR confidence when the label is otherwise clean
      const finalConfidence: ConfidenceLevel =
        pairedBarcode && ref.confidence === 'medium' && !ref.note ? 'high' : ref.confidence;

      results.push({
        customer: globalCustomer,
        type: resolvedType,
        referenceNumber: ref.referenceNumber,
        barcode: pairedBarcode,
        quantity: pairedCount,
        confidence: finalConfidence,
        timestamp: timestamp || undefined,
        notes: ref.note || undefined,
      });
    }
  }

  // 3. Any remaining tracking/1D barcodes that didn't pair with a Del/Rem number (barcode-only labels!)
  for (const tb of trackingBarcodes) {
    const key = normalizeComparisonKey(tb.text);
    if (usedBarcodeKeys.has(key)) continue;
    usedBarcodeKeys.add(key);

    const resolvedType =
      globalType !== 'Okänd'
        ? globalType
        : inferPackageType(undefined, tb.text, input.hint);

    results.push({
      customer: globalCustomer,
      type: resolvedType,
      referenceNumber: tb.text,
      barcode: tb.text,
      quantity: tb.distinctPhysicalCount,
      confidence: resolvedType === 'Okänd' ? 'medium' : 'high',
      timestamp: timestamp || undefined,
      notes:
        resolvedType === 'Okänd'
          ? 'Streckkod avläst lokalt — välj Delivery eller Removal vid behov'
          : undefined,
    });
  }

  // 4. Fallback: printed 10-22 digit barcode number read via OCR when bars were too blurry for ZXing
  if (results.length === 0) {
    const printedDigits = extractPrintedNumericBarcodeFallback(input.ocrText);
    if (printedDigits) {
      const resolvedType =
        globalType !== 'Okänd'
          ? globalType
          : inferPackageType(undefined, printedDigits, input.hint);
      results.push({
        customer: globalCustomer,
        type: resolvedType,
        referenceNumber: printedDigits,
        barcode: printedDigits,
        quantity: 1,
        confidence: input.ocrConfidence >= 78 ? 'medium' : 'low',
        timestamp: timestamp || undefined,
        notes: 'Streckkodsnummer avläst via lokal OCR — kontrollera siffror',
      });
    }
  }

  return results;
}

export interface VideoFrameDetectionSlice {
  frameIndex: number;
  timestampSec: number;
  packages: RawDetectedPackage[];
}

const CONF_SCORE: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function toConfidence(raw?: string | null): ConfidenceLevel {
  if (raw === 'high') return 'high';
  if (raw === 'low') return 'low';
  return 'medium';
}

function getSightingIdentityKey(pkg: RawDetectedPackage): string {
  const ref = pkg.referenceNumber ? normalizeComparisonKey(pkg.referenceNumber) : '';
  const bc = pkg.barcode ? normalizeComparisonKey(pkg.barcode) : '';
  return ref || bc;
}

/**
 * Aggregates per-frame detections across a video sweep so that:
 * - Hovering the camera over the SAME physical box across multiple consecutive frames counts it ONCE
 *   (while combining the sharpest customer name, barcode, type, and highest confidence seen across those frames).
 * - Filming TWO separate physical boxes with the SAME reference number (either separated by another package
 *   or separated by a clear camera-movement gap, or seen simultaneously in one wide frame) counts BOTH!
 */
export function aggregateVideoFrameDetections(
  slices: VideoFrameDetectionSlice[]
): RawDetectedPackage[] {
  interface ActiveSighting {
    key: string;
    pkg: RawDetectedPackage;
    firstSeenSec: number;
    lastSeenSec: number;
    lastFrameIndex: number;
    maxSimultaneousQty: number;
    interveningOtherKeys: Set<string>;
  }

  const activeByKey = new Map<string, ActiveSighting>();
  const finalized: RawDetectedPackage[] = [];

  const flushSighting = (s: ActiveSighting) => {
    finalized.push({
      ...s.pkg,
      quantity: Math.max(1, s.maxSimultaneousQty),
      timestamp: formatTimestampSec(s.firstSeenSec) || s.pkg.timestamp,
    });
  };

  for (const slice of slices) {
    const keysInThisFrame = new Set<string>();

    for (const pkg of slice.packages) {
      const key = getSightingIdentityKey(pkg);
      if (!key) continue;
      keysInThisFrame.add(key);

      // Also check if an active sighting existed only under barcode while this frame read both Del# + barcode
      let matchedKey = key;
      if (!activeByKey.has(matchedKey) && pkg.barcode) {
        const bcKey = normalizeComparisonKey(pkg.barcode);
        if (activeByKey.has(bcKey)) {
          const prev = activeByKey.get(bcKey)!;
          activeByKey.delete(bcKey);
          prev.key = key;
          activeByKey.set(key, prev);
          matchedKey = key;
        }
      }

      const existing = activeByKey.get(matchedKey);
      if (existing) {
        const timeGap = slice.timestampSec - existing.lastSeenSec;
        const frameGap = slice.frameIndex - existing.lastFrameIndex;
        const sawDifferentPackageBetween = existing.interveningOtherKeys.size > 0;

        // If another distinct package was scanned in between (and at least 1.2s passed),
        // OR the camera left the label for >= 2.8s across >= 3 frames, treat as a NEW physical box!
        const isNewPhysicalBox =
          (sawDifferentPackageBetween && timeGap >= 1.2) ||
          (timeGap >= 2.8 && frameGap >= 3);

        if (isNewPhysicalBox) {
          flushSighting(existing);
          activeByKey.delete(matchedKey);
        } else {
          // Upgrade existing sighting with the clearest details seen across frames
          const curConf = toConfidence(existing.pkg.confidence);
          const newConf = toConfidence(pkg.confidence);
          const bestConf = CONF_SCORE[newConf] >= CONF_SCORE[curConf] ? newConf : curConf;

          const existingCustomer = normalizeCustomerName(existing.pkg.customer);
          const incomingCustomer = normalizeCustomerName(pkg.customer);
          const bestCustomer =
            !/^okänd\s+kund$/i.test(existingCustomer) ? existingCustomer : incomingCustomer;

          const existingType = inferPackageType(existing.pkg.type, existing.pkg.referenceNumber);
          const incomingType = inferPackageType(pkg.type, pkg.referenceNumber);
          const bestType = existingType !== 'Okänd' ? existingType : incomingType;

          const existingRef = existing.pkg.referenceNumber ?? '';
          const incomingRef = pkg.referenceNumber ?? '';
          const bestRef =
            isReferenceLikeCode(existingRef) || !incomingRef ? existingRef : incomingRef;

          existing.pkg = {
            customer: bestCustomer,
            type: bestType,
            referenceNumber: bestRef || existingRef,
            barcode: existing.pkg.barcode || pkg.barcode || '',
            confidence: bestConf,
            timestamp: existing.pkg.timestamp,
            notes: bestConf === 'high' ? undefined : existing.pkg.notes || pkg.notes,
          };
          existing.lastSeenSec = slice.timestampSec;
          existing.lastFrameIndex = slice.frameIndex;
          existing.maxSimultaneousQty = Math.max(
            existing.maxSimultaneousQty,
            pkg.quantity ?? 1
          );
          continue;
        }
      }

      activeByKey.set(matchedKey, {
        key: matchedKey,
        pkg: { ...pkg },
        firstSeenSec: slice.timestampSec,
        lastSeenSec: slice.timestampSec,
        lastFrameIndex: slice.frameIndex,
        maxSimultaneousQty: Math.max(1, pkg.quantity ?? 1),
        interveningOtherKeys: new Set(),
      });
    }

    // Record intervening distinct packages for any active sighting NOT seen in this frame
    if (keysInThisFrame.size > 0) {
      for (const [activeKey, sighting] of activeByKey.entries()) {
        if (!keysInThisFrame.has(activeKey)) {
          for (const otherKey of keysInThisFrame) {
            sighting.interveningOtherKeys.add(otherKey);
          }
        }
      }
    }
  }

  for (const sighting of activeByKey.values()) {
    flushSighting(sighting);
  }

  return finalized;
}
