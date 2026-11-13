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
  // Global Tech & Cloud Customers
  { canonical: 'Microsoft', regex: /\bM[i1l|]cros[o0]ft(?:\s+(?:Corp(?:oration)?|Sverige|Sweden|AB))?\b/i },
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
  { canonical: 'Asus', regex: /\bASUS\b/i },
  { canonical: 'Acer', regex: /\bAcer\b/i },
  { canonical: 'Logitech', regex: /\bL[o0]gitech\b/i },

  // Nordic & European Enterprise / Retail / Telecom / Datacenter Customers
  { canonical: 'Ericsson', regex: /\bEricss[o0]n\b/i },
  { canonical: 'Nokia', regex: /\bN[o0]k[i1]a\b/i },
  { canonical: 'Telia', regex: /\bTe[l1]ia(?:\s+Company|\s+Sverige)?\b/i },
  { canonical: 'Tele2', regex: /\bTe[l1]e\s*2\b/i },
  { canonical: 'Telenor', regex: /\bTe[l1]en[o0]r\b/i },
  { canonical: 'Tre', regex: /\bHi3G\b/i },
  { canonical: 'ABB', regex: /\bABB\b/ },
  { canonical: 'Volvo', regex: /\bV[o0]lv[o0](?:\s+(?:Cars|Group|Lastvagnar|Trucks))?\b/i },
  { canonical: 'Scania', regex: /\bScan[i1]a\b/i },
  { canonical: 'Atlas Copco', regex: /\bAtlas\s+C[o0]pc[o0]\b/i },
  { canonical: 'Epiroc', regex: /\bEpir[o0]c\b/i },
  { canonical: 'IKEA', regex: /\bIKEA\b/i },
  { canonical: 'H&M', regex: /\bH\s*&\s*M\b/i },
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
  { canonical: 'Assa Abloy', regex: /\bAssa\s+Abl[o0]y\b/i },
  { canonical: 'Alfa Laval', regex: /\bAlfa\s+Lava[l1]\b/i },
  { canonical: 'Hexagon', regex: /\bHexag[o0]n\b/i },
  { canonical: 'Essity', regex: /\bEssity\b/i },
  { canonical: 'Axis', regex: /\bAxis\s+Communications\b/i },
  { canonical: 'Equinix', regex: /\bEqu[i1]n[i1]x\b/i },
  { canonical: 'Digital Realty', regex: /\bDigital\s+Realty\b/i },
  { canonical: 'Conapto', regex: /\bC[o0]napt[o0]\b/i },
  { canonical: 'Bahnhof', regex: /\bBahnh[o0]f\b/i },
  { canonical: 'GlobalConnect', regex: /\bGlobal\s*Connect\b/i },
  { canonical: 'Atea', regex: /\bAtea\b/i },
  { canonical: 'Dustin', regex: /\bDust[i1]n\b/i },
  { canonical: 'Advania', regex: /\bAdvan[i1]a\b/i },
  { canonical: 'Inrego', regex: /\bInreg[o0]\b/i },
  { canonical: 'Elgiganten', regex: /\bElgiganten\b/i },
  { canonical: 'NetOnNet', regex: /\bNetOnNet\b/i },
  { canonical: 'Inet', regex: /\bInet(?:\s+AB)?\b/i },
  { canonical: 'Komplett', regex: /\bKomplett\b/i },
  { canonical: 'Kjell & Company', regex: /\bKjell\s*&\s*Co(?:mpany)?\b/i },
  { canonical: 'Apotea', regex: /\bApotea\b/i },
  { canonical: 'Boozt', regex: /\bBoozt\b/i },
  { canonical: 'Zalando', regex: /\bZalando\b/i },
  { canonical: 'ICA', regex: /\bICA(?:\s+Sverige|\s+Gruppen)?\b/ },
  { canonical: 'Coop', regex: /\bCoop(?:\s+Sverige)?\b/i },
  { canonical: 'Clas Ohlson', regex: /\bClas\s+Ohls[o0]n\b/i },
  { canonical: 'Jula', regex: /\bJula(?:\s+AB)?\b/i },
  { canonical: 'Biltema', regex: /\bBiltema\b/i },

  // Logistics / Freight Carriers (used when no separate end-customer is printed)
  { canonical: 'DHL', regex: /\bDHL(?:\s+Express|\s+Freight|\s+Parcel|\s+Global)?\b/i, isCarrier: true },
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
  { canonical: 'Airmee', regex: /\bAirmee\b/i, isCarrier: true },
  { canonical: 'Early Bird', regex: /\bEarly\s*Bird\b/i, isCarrier: true },
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
  'parcel',
  'express',
  'priority',
  'standard',
  'economy',
  'kolli',
  'pallet',
  'pall',
  'weight',
  'vikt',
  'kg',
  'date',
  'datum',
  'from',
  'från',
  'avsändare',
  'sender',
  'mottagare',
  'receiver',
  'consignee',
  'sweden',
  'sverige',
  'stockholm',
  'göteborg',
  'malmö',
  'kista',
  'västerås',
  'uppsala',
  'warehouse',
  'lager',
  'gate',
  'port',
  'barcode',
  'streckkod',
  'reference',
  'referens',
  'order',
  'shipment',
  'tracking',
  'sscc',
  'ean',
  'quantity',
  'antal',
  'pcs',
  'st',
  'fragile',
  'aktas',
  'endast',
  'bara',
  'fraktsedel',
  'waybill',
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

/**
 * Filters out OCR hallucinations caused by vertical 1D barcode bars (e.g. "111I1l|111")
 * or random background punctuation noise.
 */
export function isBarcodeStripeOrNoiseText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length === 0) return true;

  // Vertical barcode stripes get read by OCR as sequences of 1, I, l, |, !, i, :
  const stripeChars = (compact.match(/[1Il|!i:\-_.,'"`\\/]/g) ?? []).length;
  if (compact.length >= 4 && stripeChars / compact.length >= 0.72) {
    // Allow genuine numeric strings ONLY if they are not almost all '1's
    const onesCount = (compact.match(/1/g) ?? []).length;
    if (onesCount / compact.length >= 0.65 || !/^\d+$/.test(compact)) {
      return true;
    }
  }

  // Reject identical repeated character runs like "00000000" or "AAAAAAA"
  if (compact.length >= 5 && /^(.)\1+$/.test(compact)) {
    return true;
  }

  return false;
}

/**
 * Validates standard GS1 Modulo-10 check digit (used on EAN-8, UPC-A, EAN-13, ITF-14, SSCC-18).
 */
export function hasValidGs1Mod10Checksum(digitsOnly: string): boolean {
  if (!/^\d+$/.test(digitsOnly)) return false;
  // Strip leading GS1 AI (00) if 20-digit SSCC string
  const code =
    digitsOnly.length === 20 && digitsOnly.startsWith('00')
      ? digitsOnly.slice(2)
      : digitsOnly;

  if (![8, 12, 13, 14, 18].includes(code.length)) return false;
  if (/^(\d)\1+$/.test(code)) return false;

  let sum = 0;
  const checkDigit = Number(code[code.length - 1]);
  const body = code.slice(0, -1);

  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    const weight = i % 2 === 0 ? 3 : 1;
    sum += d * weight;
  }

  const expected = (10 - (sum % 10)) % 10;
  return checkDigit === expected;
}

function looksLikeDateOrPhoneOrPostalCode(raw: string): boolean {
  const trimmed = raw.trim();
  // ISO or European dates: 2026-11-13, 13-11-2026, 20261113
  if (/^(?:19|20)\d{2}[\-/.]?(?:0[1-9]|1[0-2])[\-/.]?(?:0[1-9]|[12]\d|3[01])$/.test(trimmed)) {
    return true;
  }
  if (/^(?:0[1-9]|[12]\d|3[01])[\-/.](?:0[1-9]|1[0-2])[\-/.](?:19|20)\d{2}$/.test(trimmed)) {
    return true;
  }
  // Swedish 5-digit postal code like "164 40" or "SE-16440"
  if (/^(?:SE[\s\-]?)?\d{3}\s?\d{2}$/i.test(trimmed)) {
    return true;
  }
  // Swedish phone numbers like +46701234567 or 070-123 45 67 or 08-1234567
  if (/^(?:\+46|0046|07[02369]|08)[\s\-]?\d{5,9}$/.test(trimmed.replace(/\s+/g, ''))) {
    return true;
  }
  return false;
}

export function cleanBarcodeValue(raw: string): string {
  if (!raw) return '';
  let cleaned = raw
    .replace(/^\][A-Za-z][0-9]/, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();

  // Flatten GS1 HRI format like "(00) 373125519820123456"
  if (/^\(\d{2,4}\)[\d\s()]+$/.test(cleaned)) {
    cleaned = cleaned.replace(/[()\s]+/g, '');
  }

  return cleaned.trim();
}

function isReferenceLikeCode(code: string): boolean {
  const compact = code.replace(/[\s\-_]+/g, '');
  return /^(DEL|DLV|INL|REM|RMV|RET|UTL|RMA|ORD|SHP|RITM|INC|CHG|PO|SO)[A-Z0-9]{4,24}$/i.test(
    compact
  );
}

function normalizeDelRemPrefixAndTail(rawPrefix: string, rawTail: string): {
  normalized: string;
  impliedType: PackageType;
  repairedAmbiguous: boolean;
  prefixRepaired: boolean;
} {
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
  } else if (
    upperPrefix === 'RMV' ||
    upperPrefix === 'RET' ||
    upperPrefix === 'UTL' ||
    upperPrefix === 'RMA'
  ) {
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
  if (isBarcodeStripeOrNoiseText(trimmed)) return null;
  if (/^\d+$/.test(trimmed)) return null;
  if (looksLikeDateOrPhoneOrPostalCode(trimmed)) return null;
  if (/^(del|rem|dlv|rmv|inl|ret|rma)\d/i.test(trimmed)) return null;
  // Reject street-address-like lines ("Storgatan 12", "Gate 4", "Box 102")
  if (/\b(?:gatan|vägen|gränd|allén|torget|box|gate|port)\s+\d+/i.test(trimmed)) return null;

  const words = trimmed.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  if (words.every((w) => STOPWORD_CUSTOMER_TOKENS.has(w.toLowerCase()))) return null;

  // Require at least one vowel in alphabetic words > 3 chars so OCR consonant garbage ("Brtk") is rejected
  const alphaOnly = trimmed.replace(/[^A-Za-zÅÄÖåäö]/g, '');
  if (alphaOnly.length >= 4 && !/[aeiouyåäöAEIOUYÅÄÖ]/.test(alphaOnly)) {
    return null;
  }

  return normalizeCustomerName(trimmed);
}

export function extractCustomerFromText(
  ocrText: string,
  ocrLines?: OcrLineBox[],
  hint?: string
): string {
  const structuredLines: OcrLineBox[] =
    ocrLines && ocrLines.length > 0
      ? ocrLines.filter((l) => (l.confidence ?? 80) >= 42 && !isBarcodeStripeOrNoiseText(l.text))
      : ocrText
          .split(/\r?\n/)
          .map((t) => ({ text: t.trim(), confidence: 80 }))
          .filter((l) => Boolean(l.text) && !isBarcodeStripeOrNoiseText(l.text));

  const lines = structuredLines.map((l) => l.text.trim()).filter(Boolean);

  // Tier 1a: Explicit same-line field ("Kund: Microsoft", "Mottagare: Volvo AB", "Ship To: ABB")
  const explicitSameLineRegex =
    /(?:^|\b)(?:Kund|Customer|Client|Mottagare|Receiver|Beställare|Ship\s*To|Deliver\s*To|Consignee|Account|Företag|Uppdragsgivare)\s*[:#\-]\s*([A-Za-zÅÄÖåäö0-9&.\- ]{2,42})/i;

  // Tier 1b: Header-only line ("MOTTAGARE:" / "SHIP TO" / "KUND") where customer name is on the NEXT line!
  const headerOnlyRegex =
    /^(?:Kund|Customer|Client|Mottagare|Receiver|Beställare|Ship\s*To|Deliver\s*To|Consignee|Leveransadress|Till|To)\s*[:#\-]?$/i;

  for (let i = 0; i < structuredLines.length; i++) {
    const line = structuredLines[i].text.trim();
    const sameLineMatch = line.match(explicitSameLineRegex);
    if (sameLineMatch?.[1]) {
      for (const brand of BRAND_PATTERNS) {
        if (brand.regex.test(sameLineMatch[1])) {
          return brand.canonical;
        }
      }
      const cleaned = cleanExplicitCustomerCandidate(sameLineMatch[1]);
      if (cleaned && cleaned !== 'Okänd kund') {
        return cleaned;
      }
    }

    if (headerOnlyRegex.test(line) && i + 1 < structuredLines.length) {
      const nextLineObj = structuredLines[i + 1];
      if ((nextLineObj.confidence ?? 80) >= 60) {
        for (const brand of BRAND_PATTERNS) {
          if (brand.regex.test(nextLineObj.text)) {
            return brand.canonical;
          }
        }
        const cleanedNext = cleanExplicitCustomerCandidate(nextLineObj.text);
        if (cleanedNext && cleanedNext !== 'Okänd kund') {
          return cleanedNext;
        }
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

  // Tier 3: Validated Corporate Legal Suffix (e.g. "Nordic Datacenter AB", "Acme Corp") on confident OCR lines
  const legalSuffixRegex =
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&\-]{1,20}(?:[ \t]+[A-ZÅÄÖa-zåäö0-9&\-]{2,20}){0,2}[ \t]+(?:AB|Aktiebolag|AS|A\/S|Oy|Oyj|Inc\.?|Ltd\.?|GmbH|Corp\.?))\b/;
  for (const lineObj of structuredLines) {
    if ((lineObj.confidence ?? 80) < 65) continue;
    // Skip sender lines ("Avsändare: ...") so we don't pick sender over receiver
    if (/^(?:Avsändare|From|Sender|Ship\s*From)\b/i.test(lineObj.text.trim())) continue;
    const match = lineObj.text.match(legalSuffixRegex);
    if (match?.[1]) {
      const candidate = cleanExplicitCustomerCandidate(match[1]);
      if (candidate && candidate !== 'Okänd kund') {
        return candidate;
      }
    }
  }

  // Tier 2b: Logistics Carrier Brands (e.g. DHL, PostNord, DB Schenker, UPS, Bring)
  for (const brand of BRAND_PATTERNS) {
    if (brand.isCarrier && brand.regex.test(combinedText)) {
      return brand.canonical;
    }
  }

  // Tier 4: User-provided hint fallback (e.g. "Microsoft Delivery" or "Volvo")
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

function isValidReferenceCodeToken(code: string): boolean {
  const compact = code.replace(/[\s\-_]+/g, '');
  if (compact.length < 5 || compact.length > 26) return false;
  if (isBarcodeStripeOrNoiseText(compact)) return false;
  if (looksLikeDateOrPhoneOrPostalCode(code)) return false;
  // Reject box fraction patterns like "Del1av3" or "1of4"
  if (/\d+(?:av|of)\d+/i.test(compact)) return false;
  const digits = (compact.match(/\d/g) ?? []).length;
  return digits >= 3;
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
    if (!isValidReferenceCodeToken(cand.referenceNumber)) return;
    const key = normalizeComparisonKey(cand.referenceNumber);
    if (!key || key.length < 5) return;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    found.push(cand);
  };

  // Pass 1a: Strictly single-line Del / Rem / DLV / RMV / INL / RET / UTL / RMA codes (note [ \t] instead of \s!)
  const directPrefixRegex =
    /\b(Del|DEL|DLV|INL|Rem|REM|RMV|RET|UTL|RMA|De[1I|]|0el|Re(?:rn|m))[ \t\-_:]*([A-Z0-9][A-Z0-9OIoIl|SB \t\-]{3,22})\b/g;

  lines.forEach((lineObj, idx) => {
    const lineText = lineObj.text?.trim() ?? '';
    if (!lineText || isBarcodeStripeOrNoiseText(lineText)) return;

    const lineConf = typeof lineObj.confidence === 'number' ? lineObj.confidence : overallConfidence;
    if (lineConf < 40) return;

    const centerY = lineObj.bbox ? (lineObj.bbox.y0 + lineObj.bbox.y1) / 2 : undefined;
    const centerX = lineObj.bbox ? (lineObj.bbox.x0 + lineObj.bbox.x1) / 2 : undefined;

    for (const match of lineText.matchAll(directPrefixRegex)) {
      const rawPrefix = match[1];
      // Stop before any space followed by words (e.g. "Del001234567 Vikt 4kg" or "Del 1 av 3")
      if (/^[0-9]+[ \t]+(?:av|of|st|kg)\b/i.test(match[2].trim())) continue;
      const rawTailChunk = match[2].trim().split(/[ \t]+(?=[A-Za-zåäöÅÄÖ]{2,})/)[0];
      const compactCheck = rawTailChunk.replace(/[ \t\-]+/g, '');
      if (compactCheck.length < 4 || compactCheck.length > 20) continue;

      if (/^(De[1I|]|0el|Rern)$/i.test(rawPrefix) && !/^0[\dOIoIl|]{4,}$/.test(compactCheck)) {
        continue;
      }

      const { normalized, impliedType, repairedAmbiguous, prefixRepaired } =
        normalizeDelRemPrefixAndTail(rawPrefix, compactCheck);

      if (!isValidReferenceCodeToken(normalized)) continue;

      let confidence: ConfidenceLevel =
        lineConf >= 78 ? 'high' : lineConf >= 56 ? 'medium' : 'low';
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

    // Pass 1b: "Delivery Nr: 001234567" / "Removal ID: 004891203"
    const labeledDelRemRegex =
      /\b(Delivery|Inleverans|Removal|Retur|Utlastning|RMA)[ \t]*(?:nr|no|num(?:ber|mer)?|id|ref|#|:)[ \t.:\-#]*([A-Z0-9][A-Z0-9\-]{4,22})\b/gi;
    for (const match of lineText.matchAll(labeledDelRemRegex)) {
      const keyword = match[1];
      const rawCode = match[2].trim();
      if (/^(delivery|removal|kund|customer)$/i.test(rawCode)) continue;
      if (looksLikeDateOrPhoneOrPostalCode(rawCode)) continue;

      const impliedType = inferPackageType(keyword, rawCode);
      const hasPrefixAlready = /^(del|dlv|inl|rem|rmv|ret|utl|rma)/i.test(rawCode);
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
        confidence: lineConf >= 75 ? 'high' : lineConf >= 55 ? 'medium' : 'low',
        centerY,
        centerX,
        lineIndex: idx,
      });
    }
  });

  if (found.length > 0) {
    return found;
  }

  // Pass 2: Explicit warehouse/shipping reference labels & standard carrier tracking formats
  const genericRefRegex =
    /\b(?:Ref(?:erens|erence)?|Order(?:[ \t]*nr|[ \t]*no|[ \t]*id)?|Beställningsnr|Shipment(?:[ \t]*ID)?|Kolli(?:[ \t]*-?[ \t]*ID|[ \t]*nr)?|Sändnings(?:-?id|nr)|Tracking(?:[ \t]*no)?|Waybill|AWB|PO|SO)[ \t]*[:#.]+[ \t]*([A-Z0-9][A-Z0-9\-_]{4,24})\b/gi;

  // Well-known logistics & IT asset tracking patterns (UPS 1Z, PostNord/DHL JJD/JVGL/UPU, ServiceNow RITM/INC)
  const structuredTrackingRegex =
    /\b(1Z[A-Z0-9]{16}|JJD\d{12,20}|JVGL\d{10,20}|0037\d{16}|[A-Z]{2}\d{9}SE|(?:RITM|INC|CHG|SCTASK|SHP|ORD)[0-9]{5,14})\b/g;

  lines.forEach((lineObj, idx) => {
    const lineText = lineObj.text?.trim() ?? '';
    const lineConf = typeof lineObj.confidence === 'number' ? lineObj.confidence : overallConfidence;
    if (!lineText || lineConf < 52 || isBarcodeStripeOrNoiseText(lineText)) return;

    const centerY = lineObj.bbox ? (lineObj.bbox.y0 + lineObj.bbox.y1) / 2 : undefined;
    const centerX = lineObj.bbox ? (lineObj.bbox.x0 + lineObj.bbox.x1) / 2 : undefined;

    for (const match of lineText.matchAll(genericRefRegex)) {
      const code = match[1].trim();
      if (/\d/.test(code) && !looksLikeDateOrPhoneOrPostalCode(code)) {
        addCandidate({
          referenceNumber: code,
          impliedType: inferPackageType(undefined, code, lineText),
          confidence: lineConf >= 78 ? 'high' : 'medium',
          centerY,
          centerX,
          lineIndex: idx,
        });
      }
    }

    for (const match of lineText.matchAll(structuredTrackingRegex)) {
      addCandidate({
        referenceNumber: match[1],
        impliedType: inferPackageType(undefined, match[1], lineText),
        confidence: lineConf >= 75 ? 'high' : 'medium',
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
      // Not valid JSON
    }
  }

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
    if (isBarcodeStripeOrNoiseText(cleaned)) continue;

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

/**
 * Strict fallback for human-readable barcode digits printed below 1D bars:
 * Only accepts confident lines that pass GS1 Modulo-10 checksum (EAN-8/12/13/14/SSCC-18)
 * or clean 12-20 digit SSCC/tracking strings that are NOT phone numbers, dates, or stripe noise.
 */
function extractPrintedNumericBarcodeFallback(
  ocrText: string,
  ocrLines?: OcrLineBox[],
  overallConfidence = 80
): { code: string; verifiedChecksum: boolean } | null {
  const lines: OcrLineBox[] =
    ocrLines && ocrLines.length > 0
      ? ocrLines
      : ocrText.split(/\r?\n/).map((text) => ({ text, confidence: overallConfidence }));

  for (const lineObj of lines) {
    const trimmed = lineObj.text.trim();
    const conf = lineObj.confidence ?? overallConfidence;
    if (conf < 68 || isBarcodeStripeOrNoiseText(trimmed)) continue;

    // Match standalone numeric / GS1 AI line like "(00) 373325380001234565" or "7 310012 345678"
    if (/^(?:\(\d{2,4}\)[ \t]*)?\d[\d \t]{7,23}\d$/.test(trimmed)) {
      const digits = trimmed.replace(/[()\s]+/g, '');
      if (digits.length < 8 || digits.length > 22) continue;
      if (looksLikeDateOrPhoneOrPostalCode(digits)) continue;

      if (hasValidGs1Mod10Checksum(digits)) {
        return { code: digits, verifiedChecksum: true };
      }

      // Only accept non-GS1-checksum pure digits if very high OCR confidence and >= 12 digits
      if (conf >= 84 && digits.length >= 12) {
        return { code: digits, verifiedChecksum: false };
      }
    }
  }
  return null;
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

  // 1. Structured 2D QR / DataMatrix payloads
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

  const refBarcodes = barcodeGroups.filter(
    (b) => !usedBarcodeKeys.has(normalizeComparisonKey(b.text)) && isReferenceLikeCode(b.text)
  );
  const trackingBarcodes = barcodeGroups.filter(
    (b) => !usedBarcodeKeys.has(normalizeComparisonKey(b.text)) && !isReferenceLikeCode(b.text)
  );

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
    const existing = mergedRefs.find((m) => normalizeComparisonKey(m.referenceNumber) === key);
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
      } else if (availableTracking.length > 0 && ref.centerY !== undefined) {
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
        const printed = extractPrintedNumericBarcodeFallback(
          input.ocrText,
          input.ocrLines,
          input.ocrConfidence
        );
        if (printed) {
          pairedBarcode = printed.code;
        }
      }

      const resolvedType =
        ref.impliedType !== 'Okänd'
          ? ref.impliedType
          : globalType !== 'Okänd'
            ? globalType
            : inferPackageType(undefined, ref.referenceNumber, input.hint);

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

  // 3. Remaining real scanned 1D/2D barcodes (checksum-verified by ZXing/BarcodeDetector!)
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
          ? 'Streckkod avläst — välj Delivery eller Removal vid behov'
          : undefined,
    });
  }

  // 4. Strict fallback: GS1 checksum-verified printed barcode digits when bars couldn't decode
  if (results.length === 0) {
    const printed = extractPrintedNumericBarcodeFallback(
      input.ocrText,
      input.ocrLines,
      input.ocrConfidence
    );
    if (printed) {
      const resolvedType =
        globalType !== 'Okänd'
          ? globalType
          : inferPackageType(undefined, printed.code, input.hint);
      results.push({
        customer: globalCustomer,
        type: resolvedType,
        referenceNumber: printed.code,
        barcode: printed.code,
        quantity: 1,
        confidence: printed.verifiedChecksum ? 'medium' : 'low',
        timestamp: timestamp || undefined,
        notes: printed.verifiedChecksum
          ? 'GS1-streckkod avläst via OCR'
          : 'Streckkodsnummer avläst via OCR — kontrollera siffror',
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

export function mergePackageSightingDetails(
  existingPkg: RawDetectedPackage,
  incomingPkg: RawDetectedPackage
): RawDetectedPackage {
  const curConf = toConfidence(existingPkg.confidence);
  const newConf = toConfidence(incomingPkg.confidence);
  const bestConf = CONF_SCORE[newConf] >= CONF_SCORE[curConf] ? newConf : curConf;

  const existingCustomer = normalizeCustomerName(existingPkg.customer);
  const incomingCustomer = normalizeCustomerName(incomingPkg.customer);
  const bestCustomer = !/^okänd\s+kund$/i.test(existingCustomer)
    ? existingCustomer
    : incomingCustomer;

  const existingType = inferPackageType(existingPkg.type, existingPkg.referenceNumber);
  const incomingType = inferPackageType(incomingPkg.type, incomingPkg.referenceNumber);
  const bestType = existingType !== 'Okänd' ? existingType : incomingType;

  const existingRef = existingPkg.referenceNumber ?? '';
  const incomingRef = incomingPkg.referenceNumber ?? '';
  // Prefer explicit Del/Rem reference over raw numeric barcode when merging frames of the same label
  const bestRef =
    isReferenceLikeCode(existingRef)
      ? existingRef
      : isReferenceLikeCode(incomingRef)
        ? incomingRef
        : existingRef || incomingRef;

  return {
    customer: bestCustomer,
    type: bestType,
    referenceNumber: bestRef,
    barcode: existingPkg.barcode || incomingPkg.barcode || '',
    confidence: bestConf,
    timestamp: existingPkg.timestamp || incomingPkg.timestamp,
    notes: bestConf === 'high' ? undefined : existingPkg.notes || incomingPkg.notes,
  };
}

export function aggregateVideoFrameDetections(
  slices: VideoFrameDetectionSlice[]
): RawDetectedPackage[] {
  interface ActiveSighting {
    key: string;
    barcodeKey: string;
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
      const primaryKey = getSightingIdentityKey(pkg);
      if (!primaryKey) continue;
      const bcKey = pkg.barcode ? normalizeComparisonKey(pkg.barcode) : '';

      // Match either by primary reference key OR by shared barcode key
      // (e.g. Frame 1 decoded barcode 7310012345678, Frame 2 decoded both Del001234567 + 7310012345678!)
      let matchedKey = primaryKey;
      if (!activeByKey.has(matchedKey)) {
        for (const [k, s] of activeByKey.entries()) {
          if (
            (bcKey && (k === bcKey || s.barcodeKey === bcKey)) ||
            (s.barcodeKey && s.barcodeKey === primaryKey)
          ) {
            activeByKey.delete(k);
            s.key = primaryKey;
            s.barcodeKey = bcKey || s.barcodeKey;
            activeByKey.set(primaryKey, s);
            matchedKey = primaryKey;
            break;
          }
        }
      }

      keysInThisFrame.add(matchedKey);

      const existing = activeByKey.get(matchedKey);
      if (existing) {
        const timeGap = slice.timestampSec - existing.lastSeenSec;
        const frameGap = slice.frameIndex - existing.lastFrameIndex;
        const sawDifferentPackageBetween = existing.interveningOtherKeys.size > 0;

        const isNewPhysicalBox =
          (sawDifferentPackageBetween && timeGap >= 1.1) ||
          (timeGap >= 2.6 && frameGap >= 3);

        if (isNewPhysicalBox) {
          flushSighting(existing);
          activeByKey.delete(matchedKey);
        } else {
          existing.pkg = mergePackageSightingDetails(existing.pkg, pkg);
          if (bcKey) existing.barcodeKey = bcKey;
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
        barcodeKey: bcKey,
        pkg: { ...pkg },
        firstSeenSec: slice.timestampSec,
        lastSeenSec: slice.timestampSec,
        lastFrameIndex: slice.frameIndex,
        maxSimultaneousQty: Math.max(1, pkg.quantity ?? 1),
        interveningOtherKeys: new Set(),
      });
    }

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
