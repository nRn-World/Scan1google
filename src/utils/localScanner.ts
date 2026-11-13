import Tesseract from 'tesseract.js';
import { simd } from 'wasm-feature-detect';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import {
  prepareZXingModule as prepareZXingWriterModule,
  writeBarcode,
} from 'zxing-wasm/writer';
import {
  mergeInventoryItems,
  normalizeComparisonKey,
  type InventoryItem,
  type RawDetectedPackage,
} from './inventory';
import {
  aggregateVideoFrameDetections,
  formatTimestampSec,
  isBarcodeStripeOrNoiseText,
  mergePackageSightingDetails,
  parseLabelFrame,
  type DetectedBarcodeRead,
  type OcrLineBox,
  type VideoFrameDetectionSlice,
} from './labelParser';

export interface ScanProgress {
  phase: 'preparing' | 'extracting-frames' | 'loading-engine' | 'scanning' | 'finalizing';
  percent: number;
  message: string;
  currentFrame?: number;
  totalFrames?: number;
  foundSoFar?: number;
}

export interface CapturedCameraFrame {
  canvas: HTMLCanvasElement;
  labelCanvas?: HTMLCanvasElement;
  timestampSec: number;
  sharpness: number;
}

export interface LocalScanResult {
  items: InventoryItem[];
  rawPackages: RawDetectedPackage[];
  summaryNote: string;
}

export interface LiveScannedEntry {
  uid: string;
  pkg: RawDetectedPackage;
  firstSeenSec: number;
  lastSeenSec: number;
}

function getLocalAssetBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    const baseUrl = import.meta.env?.BASE_URL || '/';
    return new URL(baseUrl, window.location.origin).href.replace(/\/$/, '');
  }
  return 'http://localhost:3000';
}

function getLocalAssetUrl(fileName: string): string {
  const base = getLocalAssetBaseUrl();
  return fileName ? `${base}/ocr-assets/${fileName}` : `${base}/ocr-assets`;
}

let zxingReaderConfigured = false;
let zxingWriterConfigured = false;
let tesseractWorkerPromise: Promise<Tesseract.Worker> | null = null;
let ocrWorkerBusy = false;

function ensureZXingReaderConfigured(): void {
  if (zxingReaderConfigured) return;
  prepareZXingModule({
    overrides: {
      locateFile: (filePath: string, prefix: string) => {
        if (filePath.endsWith('.wasm')) {
          return getLocalAssetUrl('zxing_reader.wasm');
        }
        return prefix + filePath;
      },
    },
  });
  zxingReaderConfigured = true;
}

function ensureZXingWriterConfigured(): void {
  if (zxingWriterConfigured) return;
  prepareZXingWriterModule({
    overrides: {
      locateFile: (filePath: string, prefix: string) => {
        if (filePath.endsWith('.wasm')) {
          return getLocalAssetUrl('zxing_writer.wasm');
        }
        return prefix + filePath;
      },
    },
  });
  zxingWriterConfigured = true;
}

async function getLocalOcrWorker(
  onProgress?: (statusMsg: string) => void
): Promise<Tesseract.Worker> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      try {
        const supportsSimd = await simd().catch(() => false);
        const coreScript = supportsSimd
          ? 'tesseract-core-simd-lstm.wasm.js'
          : 'tesseract-core-lstm.wasm.js';

        const worker = await Tesseract.createWorker('eng+swe', Tesseract.OEM.LSTM_ONLY, {
          workerPath: getLocalAssetUrl('worker.min.js'),
          corePath: getLocalAssetUrl(coreScript),
          langPath: getLocalAssetUrl(''),
          gzip: true,
          logger: (msg) => {
            if (onProgress && msg.status && msg.status.includes('loading')) {
              onProgress('Laddar lokal OCR-modell (sparas offline på enheten)...');
            }
          },
        });

        await worker.setParameters({
          tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1',
        });

        return worker;
      } catch (err) {
        tesseractWorkerPromise = null;
        throw err;
      }
    })();
  }
  return tesseractWorkerPromise;
}

/**
 * Pre-warms both ZXing WASM and the local Tesseract Web Worker as soon as the camera opens
 * so the very first label scan happens without cold-start delay.
 */
export async function warmUpLocalScanner(): Promise<void> {
  try {
    ensureZXingReaderConfigured();
    await getLocalOcrWorker();
  } catch {
    // Non-fatal pre-warm
  }
}

interface NativeBarcodeDetection {
  rawValue?: string;
  format?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

interface NativeBarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): {
    detect(image: ImageBitmapSource): Promise<NativeBarcodeDetection[]>;
  };
}

let cachedNativeDetector: InstanceType<NativeBarcodeDetectorConstructor> | null | undefined;

function getNativeBarcodeDetector(): InstanceType<NativeBarcodeDetectorConstructor> | null {
  if (cachedNativeDetector !== undefined) return cachedNativeDetector;
  if (typeof window === 'undefined') {
    cachedNativeDetector = null;
    return null;
  }
  const Ctor = (window as unknown as { BarcodeDetector?: NativeBarcodeDetectorConstructor })
    .BarcodeDetector;
  if (!Ctor) {
    cachedNativeDetector = null;
    return null;
  }
  try {
    cachedNativeDetector = new Ctor();
    return cachedNativeDetector;
  } catch {
    cachedNativeDetector = null;
    return null;
  }
}

export function computeCanvasSharpness(canvas: HTMLCanvasElement): {
  sharpness: number;
  signature: Uint8Array;
} {
  const thumbW = 96;
  const thumbH = Math.max(24, Math.round((canvas.height / Math.max(1, canvas.width)) * thumbW));
  const tmp = document.createElement('canvas');
  tmp.width = thumbW;
  tmp.height = thumbH;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { sharpness: 0, signature: new Uint8Array(0) };
  }
  ctx.drawImage(canvas, 0, 0, thumbW, thumbH);
  const { data } = ctx.getImageData(0, 0, thumbW, thumbH);
  const gray = new Uint8Array(thumbW * thumbH);

  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }

  let edgeEnergy = 0;
  let count = 0;
  for (let y = 1; y < thumbH - 1; y++) {
    const rowOffset = y * thumbW;
    for (let x = 1; x < thumbW - 1; x++) {
      const idx = rowOffset + x;
      const gx = Math.abs(gray[idx + 1] - gray[idx - 1]);
      const gy = Math.abs(gray[idx + thumbW] - gray[idx - thumbW]);
      edgeEnergy += gx + gy;
      count++;
    }
  }

  const sigW = 24;
  const sigH = 18;
  const signature = new Uint8Array(sigW * sigH);
  for (let sy = 0; sy < sigH; sy++) {
    const srcY = Math.min(thumbH - 1, Math.floor((sy * thumbH) / sigH));
    for (let sx = 0; sx < sigW; sx++) {
      const srcX = Math.min(thumbW - 1, Math.floor((sx * thumbW) / sigW));
      signature[sy * sigW + sx] = gray[srcY * thumbW + srcX];
    }
  }

  return {
    sharpness: count > 0 ? edgeEnergy / count : 0,
    signature,
  };
}

export function signatureMeanDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}

/**
 * Automatically locates a bright, high-contrast shipping label card inside a wider camera frame
 * (filtering out surrounding brown cardboard, pallet wood, dark warehouse floor, and edges).
 */
export function cropToBrightLabelRegion(source: HTMLCanvasElement): {
  canvas: HTMLCanvasElement;
  offsetX: number;
  offsetY: number;
  wasCropped: boolean;
} {
  const srcW = source.width;
  const srcH = source.height;
  if (srcW < 240 || srcH < 240) {
    return { canvas: source, offsetX: 0, offsetY: 0, wasCropped: false };
  }

  const gridW = 48;
  const gridH = 36;
  const tmp = document.createElement('canvas');
  tmp.width = gridW;
  tmp.height = gridH;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { canvas: source, offsetX: 0, offsetY: 0, wasCropped: false };
  }

  ctx.drawImage(source, 0, 0, gridW, gridH);
  const { data } = ctx.getImageData(0, 0, gridW, gridH);
  const lum = new Uint8Array(gridW * gridH);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }

  const sortedLum = Array.from(lum).sort((a, b) => a - b);
  const medianLum = sortedLum[Math.floor(sortedLum.length * 0.5)] ?? 120;
  const p80Lum = sortedLum[Math.floor(sortedLum.length * 0.8)] ?? 180;

  // Shipping labels are bright paper with dark ink edges/bars inside
  const brightThreshold = Math.max(115, Math.round((medianLum + p80Lum) * 0.52));

  let minGX = gridW;
  let maxGX = -1;
  let minGY = gridH;
  let maxGY = -1;
  let activeCells = 0;

  for (let gy = 1; gy < gridH - 1; gy++) {
    for (let gx = 1; gx < gridW - 1; gx++) {
      const idx = gy * gridW + gx;
      const val = lum[idx];
      const localContrast =
        Math.abs(val - lum[idx - 1]) +
        Math.abs(val - lum[idx + 1]) +
        Math.abs(val - lum[idx - gridW]) +
        Math.abs(val - lum[idx + gridW]);

      const neighborMax = Math.max(
        val,
        lum[idx - 1],
        lum[idx + 1],
        lum[idx - gridW],
        lum[idx + gridW]
      );

      // Cell is either bright label paper or dark ink/barcode directly on bright label paper
      if (val >= brightThreshold || (neighborMax >= brightThreshold + 12 && localContrast >= 48)) {
        activeCells++;
        if (gx < minGX) minGX = gx;
        if (gx > maxGX) maxGX = gx;
        if (gy < minGY) minGY = gy;
        if (gy > maxGY) maxGY = gy;
      }
    }
  }

  if (maxGX <= minGX || maxGY <= minGY || activeCells < 12) {
    return { canvas: source, offsetX: 0, offsetY: 0, wasCropped: false };
  }

  const boxAreaRatio =
    ((maxGX - minGX + 1) * (maxGY - minGY + 1)) / (gridW * gridH);

  // Only crop if the detected region is a meaningful sub-region (not tiny noise and not already full frame)
  if (boxAreaRatio < 0.1 || boxAreaRatio > 0.84) {
    return { canvas: source, offsetX: 0, offsetY: 0, wasCropped: false };
  }

  const padX = Math.round(srcW * 0.08);
  const padY = Math.round(srcH * 0.08);
  const x0 = Math.max(0, Math.floor((minGX / gridW) * srcW) - padX);
  const y0 = Math.max(0, Math.floor((minGY / gridH) * srcH) - padY);
  const x1 = Math.min(srcW, Math.ceil(((maxGX + 1) / gridW) * srcW) + padX);
  const y1 = Math.min(srcH, Math.ceil(((maxGY + 1) / gridH) * srcH) + padY);
  const cropW = x1 - x0;
  const cropH = y1 - y0;

  if (cropW < 180 || cropH < 140) {
    return { canvas: source, offsetX: 0, offsetY: 0, wasCropped: false };
  }

  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  const outCtx = out.getContext('2d');
  if (!outCtx) {
    return { canvas: source, offsetX: 0, offsetY: 0, wasCropped: false };
  }
  outCtx.drawImage(source, x0, y0, cropW, cropH, 0, 0, cropW, cropH);

  return {
    canvas: out,
    offsetX: x0,
    offsetY: y0,
    wasCropped: true,
  };
}

function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const norm = ((degrees % 360) + 360) % 360;
  if (norm === 0) return source;

  const swapDims = norm === 90 || norm === 270;
  const out = document.createElement('canvas');
  out.width = swapDims ? source.height : source.width;
  out.height = swapDims ? source.width : source.height;

  const ctx = out.getContext('2d');
  if (!ctx) return source;

  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((norm * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return out;
}

/**
 * Enhances a cropped shipping label for Tesseract LSTM:
 * - Upscales small mobile crops so characters are ~300 DPI equivalent
 * - Percentile auto-levels (3%..97%) so shadows/warm warehouse light become crisp black-on-white
 * - Gentle 3x3 unsharp mask to counteract mobile lens softness
 */
function createEnhancedOcrCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const maxDim = Math.max(source.width, source.height);
  let scale = 1;
  if (maxDim > 1850) {
    scale = 1850 / maxDim;
  } else if (maxDim < 1200) {
    scale = Math.min(2.4, 1500 / Math.max(1, maxDim));
  }

  const innerW = Math.max(1, Math.round(source.width * scale));
  const innerH = Math.max(1, Math.round(source.height * scale));
  const pad = 20;

  const canvas = document.createElement('canvas');
  canvas.width = innerW + pad * 2;
  canvas.height = innerH + pad * 2;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return source;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, pad, pad, innerW, innerH);

  const imgData = ctx.getImageData(pad, pad, innerW, innerH);
  const { data } = imgData;
  const pixelCount = innerW * innerH;
  const gray = new Uint8Array(pixelCount);
  const hist = new Uint32Array(256);

  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    const lum = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    gray[i] = lum;
    hist[lum]++;
  }

  const lowTarget = Math.floor(pixelCount * 0.03);
  const highTarget = Math.floor(pixelCount * 0.96);
  let cumulative = 0;
  let low = 0;
  let high = 255;

  for (let v = 0; v < 256; v++) {
    cumulative += hist[v];
    if (cumulative >= lowTarget) {
      low = v;
      break;
    }
  }

  cumulative = 0;
  for (let v = 0; v < 256; v++) {
    cumulative += hist[v];
    if (cumulative >= highTarget) {
      high = v;
      break;
    }
  }

  const range = Math.max(42, high - low);
  const leveled = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const stretched = Math.round(((gray[i] - low) * 255) / range);
    leveled[i] = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched;
  }

  // Mild 3x3 unsharp mask to sharpen characters on phone camera crops
  for (let y = 0; y < innerH; y++) {
    const row = y * innerW;
    for (let x = 0; x < innerW; x++) {
      const idx = row + x;
      let val = leveled[idx];
      if (x > 0 && x < innerW - 1 && y > 0 && y < innerH - 1) {
        const blur =
          (leveled[idx - 1] +
            leveled[idx + 1] +
            leveled[idx - innerW] +
            leveled[idx + innerW]) >>
          2;
        const sharpened = val + ((val - blur) * 3 >> 2);
        val = sharpened < 0 ? 0 : sharpened > 255 ? 255 : sharpened;
      }
      const p = idx * 4;
      data[p] = val;
      data[p + 1] = val;
      data[p + 2] = val;
    }
  }

  ctx.putImageData(imgData, pad, pad);
  return canvas;
}

async function detectBarcodesSingleCanvas(
  canvas: HTMLCanvasElement,
  binarizer: 'LocalAverage' | 'GlobalHistogram' = 'LocalAverage',
  offsetX = 0,
  offsetY = 0
): Promise<DetectedBarcodeRead[]> {
  ensureZXingReaderConfigured();
  const results: DetectedBarcodeRead[] = [];

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    try {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const zxingHits = await readBarcodes(imageData, {
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        tryDenoise: true,
        binarizer,
        textMode: 'Plain',
        formats: ['All'],
        maxNumberOfSymbols: 12,
      });

      for (const hit of zxingHits) {
        if (!hit.isValid || !hit.text.trim()) continue;
        const xs = [
          hit.position.topLeft.x,
          hit.position.topRight.x,
          hit.position.bottomLeft.x,
          hit.position.bottomRight.x,
        ];
        const ys = [
          hit.position.topLeft.y,
          hit.position.topRight.y,
          hit.position.bottomLeft.y,
          hit.position.bottomRight.y,
        ];
        const minX = Math.min(...xs) + offsetX;
        const maxX = Math.max(...xs) + offsetX;
        const minY = Math.min(...ys) + offsetY;
        const maxY = Math.max(...ys) + offsetY;

        results.push({
          text: hit.text.trim(),
          format: hit.format,
          rotation: hit.rotation,
          position: {
            x: minX,
            y: minY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
          },
        });
      }
    } catch {
      // Fallback below
    }
  }

  const nativeDetector = getNativeBarcodeDetector();
  if (nativeDetector && binarizer === 'LocalAverage') {
    try {
      const nativeHits = await nativeDetector.detect(canvas);
      for (const hit of nativeHits) {
        if (!hit.rawValue || !hit.rawValue.trim()) continue;
        results.push({
          text: hit.rawValue.trim(),
          format: hit.format || 'Barcode',
          position: hit.boundingBox
            ? {
                x: hit.boundingBox.x + offsetX,
                y: hit.boundingBox.y + offsetY,
                width: Math.max(1, hit.boundingBox.width),
                height: Math.max(1, hit.boundingBox.height),
              }
            : undefined,
        });
      }
    } catch {
      // Ignore native detector errors
    }
  }

  return results;
}

/**
 * Multi-scale barcode detection:
 * 1) Scans the cropped bright label card first (highest pixel density per bar)
 * 2) Scans the full reticle/frame if needed
 * 3) Retries with GlobalHistogram binarizer if lighting/glare hid 1D bars
 */
export async function detectBarcodesMultiScale(
  fullCanvas: HTMLCanvasElement,
  preCropped?: { canvas: HTMLCanvasElement; offsetX: number; offsetY: number; wasCropped: boolean }
): Promise<DetectedBarcodeRead[]> {
  const cropInfo = preCropped ?? cropToBrightLabelRegion(fullCanvas);
  const allReads: DetectedBarcodeRead[] = [];

  if (cropInfo.wasCropped) {
    const croppedHits = await detectBarcodesSingleCanvas(
      cropInfo.canvas,
      'LocalAverage',
      cropInfo.offsetX,
      cropInfo.offsetY
    );
    allReads.push(...croppedHits);
  }

  const fullHits = await detectBarcodesSingleCanvas(fullCanvas, 'LocalAverage', 0, 0);
  allReads.push(...fullHits);

  if (allReads.length === 0) {
    const target = cropInfo.wasCropped ? cropInfo.canvas : fullCanvas;
    const ox = cropInfo.wasCropped ? cropInfo.offsetX : 0;
    const oy = cropInfo.wasCropped ? cropInfo.offsetY : 0;
    const globalHits = await detectBarcodesSingleCanvas(target, 'GlobalHistogram', ox, oy);
    allReads.push(...globalHits);
  }

  return allReads;
}

function extractCleanOcrLines(
  page: Tesseract.Page,
  offsetX = 0,
  offsetY = 0
): OcrLineBox[] {
  const lines: OcrLineBox[] = [];
  if (!page.blocks) return lines;

  for (const block of page.blocks) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const text = (line.text ?? '').trim();
        if (!text) continue;
        if (typeof line.confidence === 'number' && line.confidence < 36) continue;
        if (isBarcodeStripeOrNoiseText(text)) continue;

        lines.push({
          text,
          confidence: line.confidence,
          bbox: line.bbox
            ? {
                x0: line.bbox.x0 + offsetX,
                y0: line.bbox.y0 + offsetY,
                x1: line.bbox.x1 + offsetX,
                y1: line.bbox.y1 + offsetY,
              }
            : undefined,
        });
      }
    }
  }
  return lines;
}

async function recognizeCanvasOcr(
  worker: Tesseract.Worker,
  canvas: HTMLCanvasElement,
  offsetX = 0,
  offsetY = 0
): Promise<{ text: string; confidence: number; lines: OcrLineBox[] }> {
  const enhanced = createEnhancedOcrCanvas(canvas);
  const { data } = await worker.recognize(
    enhanced,
    {},
    {
      text: true,
      blocks: true,
    }
  );
  const lines = extractCleanOcrLines(data, offsetX, offsetY);
  const cleanText = lines.length > 0 ? lines.map((l) => l.text).join('\n') : data.text ?? '';
  return {
    text: cleanText,
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    lines,
  };
}

async function analyzeSingleCanvasFrame(
  worker: Tesseract.Worker,
  canvas: HTMLCanvasElement,
  frameIndex: number,
  sourceKind: 'video-frame' | 'image',
  timestampSec?: number,
  hint?: string
): Promise<RawDetectedPackage[]> {
  const cropInfo = cropToBrightLabelRegion(canvas);
  const barcodes = await detectBarcodesMultiScale(canvas, cropInfo);

  // Run OCR primarily on the cropped label region so background clutter is excluded!
  const targetOcrCanvas = cropInfo.wasCropped ? cropInfo.canvas : canvas;
  const ox = cropInfo.wasCropped ? cropInfo.offsetX : 0;
  const oy = cropInfo.wasCropped ? cropInfo.offsetY : 0;

  let ocr = await recognizeCanvasOcr(worker, targetOcrCanvas, ox, oy);

  // If the bright-crop missed header text outside the bright box, also check full canvas when needed
  let packages = parseLabelFrame({
    frameIndex,
    timestampSec,
    sourceKind,
    barcodes,
    ocrText: ocr.text,
    ocrConfidence: ocr.confidence,
    ocrLines: ocr.lines,
    hint,
  });

  if (
    cropInfo.wasCropped &&
    (packages.length === 0 || packages.every((p) => p.customer === 'Okänd kund'))
  ) {
    const fullOcr = await recognizeCanvasOcr(worker, canvas, 0, 0);
    const fullPackages = parseLabelFrame({
      frameIndex,
      timestampSec,
      sourceKind,
      barcodes,
      ocrText: `${ocr.text}\n${fullOcr.text}`,
      ocrConfidence: Math.max(ocr.confidence, fullOcr.confidence),
      ocrLines: [...ocr.lines, ...fullOcr.lines],
      hint,
    });
    if (
      fullPackages.length > packages.length ||
      fullPackages.some((p) => p.customer && p.customer !== 'Okänd kund')
    ) {
      packages = fullPackages;
      ocr = fullOcr;
    }
  }

  // Sideways phone photo recovery (90 / 180 / 270 deg barcode rotation)
  const rotatedBarcode = barcodes.find(
    (b) => b.rotation === 90 || b.rotation === 180 || b.rotation === 270
  );
  const needsRotatedRetry =
    rotatedBarcode &&
    (packages.length === 0 ||
      (packages.every((p) => p.customer === 'Okänd kund') && ocr.confidence < 58));

  if (needsRotatedRetry && rotatedBarcode?.rotation) {
    const correctedCanvas = rotateCanvas(targetOcrCanvas, 360 - rotatedBarcode.rotation);
    const rotatedOcr = await recognizeCanvasOcr(worker, correctedCanvas, 0, 0);
    const rotatedPackages = parseLabelFrame({
      frameIndex,
      timestampSec,
      sourceKind,
      barcodes,
      ocrText: rotatedOcr.text,
      ocrConfidence: rotatedOcr.confidence,
      ocrLines: rotatedOcr.lines,
      hint,
    });
    if (
      rotatedPackages.length > packages.length ||
      rotatedPackages.some((p) => p.customer && p.customer !== 'Okänd kund')
    ) {
      packages = rotatedPackages;
    }
  }

  return packages;
}

/**
 * Captures the exact visible reticle zone of a `<video class="object-cover">` element
 * at 100% native camera sensor resolution (no wide-angle background waste!).
 */
export function captureVideoElementFrame(
  videoEl: HTMLVideoElement,
  timestampSec: number,
  reticleFraction?: { widthRatio: number; heightRatio: number }
): CapturedCameraFrame | null {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;

  // Match CSS object-cover visible viewport if element has layout dimensions
  let visX = 0;
  let visY = 0;
  let visW = vw;
  let visH = vh;

  const clientW = videoEl.clientWidth;
  const clientH = videoEl.clientHeight;
  if (clientW > 0 && clientH > 0) {
    const videoAspect = vw / vh;
    const clientAspect = clientW / clientH;
    if (videoAspect > clientAspect) {
      visW = Math.round(vh * clientAspect);
      visX = Math.round((vw - visW) / 2);
    } else {
      visH = Math.round(vw / clientAspect);
      visY = Math.round((vh - visH) / 2);
    }
  }

  // Crop to guided label reticle if requested (e.g. center 88% x 76% of viewport)
  if (reticleFraction) {
    const rw = Math.round(visW * reticleFraction.widthRatio);
    const rh = Math.round(visH * reticleFraction.heightRatio);
    visX += Math.round((visW - rw) / 2);
    visY += Math.round((visH - rh) / 2);
    visW = Math.max(1, rw);
    visH = Math.max(1, rh);
  }

  const maxTarget = 1800;
  const scale = Math.min(1, maxTarget / Math.max(visW, visH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(visW * scale));
  canvas.height = Math.max(1, Math.round(visH * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(videoEl, visX, visY, visW, visH, 0, 0, canvas.width, canvas.height);
  const { sharpness } = computeCanvasSharpness(canvas);
  const labelCrop = cropToBrightLabelRegion(canvas);

  return {
    canvas,
    labelCanvas: labelCrop.wasCropped ? labelCrop.canvas : undefined,
    timestampSec,
    sharpness,
  };
}

/**
 * Real-time live camera tracker:
 * - Immediately locks onto barcodes (~35ms) and upgrades them with OCR customer/type/Del-Rem on steady frames
 * - Prevents duplicate counting while hovering on the same label
 * - Fires `onPackageConfirmed` for each distinct label so the mobile camera UI flashes green + vibrates + shows live chips!
 */
export class LiveCameraScannerSession {
  private entries: LiveScannedEntry[] = [];
  private activeEntryUidByKey = new Map<string, string>();
  private lastSeenSecByKey = new Map<string, number>();
  private emptyTicksSinceLastHit = 0;
  private prevSignature: Uint8Array | null = null;
  private tickCounter = 0;

  private getIdentityKeys(pkg: RawDetectedPackage): string[] {
    const keys: string[] = [];
    if (pkg.referenceNumber) {
      const rk = normalizeComparisonKey(pkg.referenceNumber);
      if (rk) keys.push(rk);
    }
    if (pkg.barcode) {
      const bk = normalizeComparisonKey(pkg.barcode);
      if (bk && !keys.includes(bk)) keys.push(bk);
    }
    return keys;
  }

  public getEntries(): LiveScannedEntry[] {
    return [...this.entries];
  }

  public removeEntry(uid: string): LiveScannedEntry[] {
    this.entries = this.entries.filter((e) => e.uid !== uid);
    for (const [k, v] of this.activeEntryUidByKey.entries()) {
      if (v === uid) this.activeEntryUidByKey.delete(k);
    }
    return this.getEntries();
  }

  public incrementEntryQuantity(uid: string): LiveScannedEntry[] {
    this.entries = this.entries.map((e) =>
      e.uid === uid
        ? {
            ...e,
            pkg: {
              ...e.pkg,
              quantity: Math.max(1, e.pkg.quantity ?? 1) + 1,
            },
          }
        : e
    );
    return this.getEntries();
  }

  public ingestDetectedPackages(
    packages: RawDetectedPackage[],
    elapsedSec: number
  ): {
    newlyLocked: LiveScannedEntry[];
    updated: boolean;
    entries: LiveScannedEntry[];
  } {
    if (packages.length === 0) {
      this.emptyTicksSinceLastHit++;
      // Once camera has seen >= 4 consecutive empty ticks (~1.6s of pointing away from any label),
      // clear active dwell locks so a second identical box can be scanned next!
      if (this.emptyTicksSinceLastHit >= 4) {
        this.activeEntryUidByKey.clear();
      }
      return { newlyLocked: [], updated: false, entries: this.getEntries() };
    }

    this.emptyTicksSinceLastHit = 0;
    const newlyLocked: LiveScannedEntry[] = [];
    let updated = false;
    const seenUidsThisTick = new Set<string>();

    for (const pkg of packages) {
      const keys = this.getIdentityKeys(pkg);
      if (keys.length === 0) continue;

      let matchedUid: string | undefined;
      for (const k of keys) {
        const uid = this.activeEntryUidByKey.get(k);
        if (uid) {
          matchedUid = uid;
          break;
        }
      }

      // Also check recently locked entries within the last 3.2s if no different package was scanned after it
      if (!matchedUid && this.entries.length > 0) {
        const latestEntry = this.entries[this.entries.length - 1];
        const latestKeys = this.getIdentityKeys(latestEntry.pkg);
        const sharesKey = keys.some((k) => latestKeys.includes(k));
        if (sharesKey && elapsedSec - latestEntry.lastSeenSec < 3.2) {
          matchedUid = latestEntry.uid;
        }
      }

      if (matchedUid) {
        const idx = this.entries.findIndex((e) => e.uid === matchedUid);
        if (idx >= 0) {
          const prev = this.entries[idx];
          const mergedPkg = mergePackageSightingDetails(prev.pkg, pkg);
          const changed =
            mergedPkg.customer !== prev.pkg.customer ||
            mergedPkg.referenceNumber !== prev.pkg.referenceNumber ||
            mergedPkg.type !== prev.pkg.type ||
            mergedPkg.barcode !== prev.pkg.barcode;

          this.entries[idx] = {
            ...prev,
            pkg: {
              ...mergedPkg,
              quantity: Math.max(prev.pkg.quantity ?? 1, pkg.quantity ?? 1),
            },
            lastSeenSec: elapsedSec,
          };

          for (const k of this.getIdentityKeys(mergedPkg)) {
            this.activeEntryUidByKey.set(k, matchedUid);
            this.lastSeenSecByKey.set(k, elapsedSec);
          }

          seenUidsThisTick.add(matchedUid);
          if (changed) updated = true;
          continue;
        }
      }

      // Brand-new physical package label!
      const uid = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const freshEntry: LiveScannedEntry = {
        uid,
        pkg: {
          ...pkg,
          quantity: Math.max(1, pkg.quantity ?? 1),
          timestamp: formatTimestampSec(elapsedSec),
        },
        firstSeenSec: elapsedSec,
        lastSeenSec: elapsedSec,
      };

      // Seeing a different package unlocks dwell lock on earlier packages (allowing Box A -> Box B -> Box A2)
      for (const [k, activeUid] of this.activeEntryUidByKey.entries()) {
        if (!seenUidsThisTick.has(activeUid)) {
          this.activeEntryUidByKey.delete(k);
        }
      }

      this.entries.push(freshEntry);
      for (const k of keys) {
        this.activeEntryUidByKey.set(k, uid);
        this.lastSeenSecByKey.set(k, elapsedSec);
      }
      seenUidsThisTick.add(uid);
      newlyLocked.push(freshEntry);
      updated = true;
    }

    return {
      newlyLocked,
      updated,
      entries: this.getEntries(),
    };
  }

  /**
   * Processes a live camera frame:
   * 1) Always runs ultra-fast multi-scale barcode detection (~35ms)
   * 2) Runs cropped label OCR when camera is steady (not mid-pan) and worker is free
   */
  public async processLiveVideoFrame(
    videoEl: HTMLVideoElement,
    elapsedSec: number,
    hint?: string
  ): Promise<{
    newlyLocked: LiveScannedEntry[];
    updated: boolean;
    entries: LiveScannedEntry[];
    motionState: 'panning' | 'steady' | 'reading-ocr';
  }> {
    this.tickCounter++;
    const captured = captureVideoElementFrame(videoEl, elapsedSec, {
      widthRatio: 0.9,
      heightRatio: 0.78,
    });
    if (!captured) {
      return {
        newlyLocked: [],
        updated: false,
        entries: this.getEntries(),
        motionState: 'steady',
      };
    }

    const { sharpness, signature } = computeCanvasSharpness(captured.canvas);
    const motionDiff = this.prevSignature
      ? signatureMeanDiff(this.prevSignature, signature)
      : 0;
    this.prevSignature = signature;

    const cropInfo = cropToBrightLabelRegion(captured.canvas);

    // Step 1: Fast barcode check works even with slight hand movement!
    const barcodes = await detectBarcodesMultiScale(captured.canvas, cropInfo);

    const isSteady = motionDiff < 15 && sharpness >= 4.5;

    // Step 2: If steady (or barcode found!) and OCR worker is idle, run targeted label OCR
    if ((isSteady || barcodes.length > 0) && !ocrWorkerBusy) {
      ocrWorkerBusy = true;
      try {
        const worker = await getLocalOcrWorker();
        const targetOcrCanvas = cropInfo.wasCropped ? cropInfo.canvas : captured.canvas;
        const ox = cropInfo.wasCropped ? cropInfo.offsetX : 0;
        const oy = cropInfo.wasCropped ? cropInfo.offsetY : 0;

        const ocr = await recognizeCanvasOcr(worker, targetOcrCanvas, ox, oy);
        const detected = parseLabelFrame({
          frameIndex: this.tickCounter,
          timestampSec: elapsedSec,
          sourceKind: 'video-frame',
          barcodes,
          ocrText: ocr.text,
          ocrConfidence: ocr.confidence,
          ocrLines: ocr.lines,
          hint,
        });

        const res = this.ingestDetectedPackages(detected, elapsedSec);
        return {
          ...res,
          motionState: 'reading-ocr',
        };
      } finally {
        ocrWorkerBusy = false;
      }
    }

    // Even if OCR worker was busy on previous frame, lock in any checksum-verified barcode immediately!
    if (barcodes.length > 0) {
      const quickPackages = parseLabelFrame({
        frameIndex: this.tickCounter,
        timestampSec: elapsedSec,
        sourceKind: 'video-frame',
        barcodes,
        ocrText: '',
        ocrConfidence: 0,
        hint,
      });
      const res = this.ingestDetectedPackages(quickPackages, elapsedSec);
      return {
        ...res,
        motionState: isSteady ? 'steady' : 'panning',
      };
    }

    if (!isSteady) {
      return {
        newlyLocked: [],
        updated: false,
        entries: this.getEntries(),
        motionState: 'panning',
      };
    }

    this.ingestDetectedPackages([], elapsedSec);
    return {
      newlyLocked: [],
      updated: false,
      entries: this.getEntries(),
      motionState: 'steady',
    };
  }

  public buildFinalScanResult(): LocalScanResult {
    const rawPackages = this.entries.map((e) => e.pkg);
    const items = mergeInventoryItems([], rawPackages);
    const reviewCount = items.filter((i) => i.needsReview).length;
    const summaryNote =
      `Avläst direkt i kameran (${this.entries.length} etikett${
        this.entries.length === 1 ? '' : 'er'
      }) helt lokalt utan API.` +
      (reviewCount > 0
        ? ` Kontrollera ${reviewCount} rad${reviewCount > 1 ? 'er' : ''} markerad med "Kontrollera".`
        : '');

    return {
      items,
      rawPackages,
      summaryNote,
    };
  }
}

async function loadImageFileToCanvas(file: File): Promise<HTMLCanvasElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
      if (canvas.width > 0 && canvas.height > 0) {
        return canvas;
      }
    } catch {
      // Fallback below
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) {
        reject(new Error(`Kunde inte läsa bildfilen "${file.name}".`));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Kunde inte avkoda bildfilen "${file.name}".`));
    };
    img.src = url;
  });
}

function seekVideoTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', finish);
      video.removeEventListener('error', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, 1800);
    video.addEventListener('seeked', finish, { once: true });
    video.addEventListener('error', finish, { once: true });
    try {
      video.currentTime = Math.max(0, timeSec);
    } catch {
      finish();
    }
  });
}

async function extractFramesFromVideoFile(
  file: File,
  onProgress?: (progress: ScanProgress) => void
): Promise<Array<{ canvas: HTMLCanvasElement; timestampSec: number; signature: Uint8Array }>> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error('Tidsgräns vid inläsning av videofilen.'));
      }, 10000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(
          new Error(
            `Webbläsaren kunde inte spela upp videofilen "${file.name}". Prova MP4, WebM eller bildfiler.`
          )
        );
      };
    });

    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      await seekVideoTo(video, 1e8);
      duration =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : video.currentTime;
      await seekVideoTo(video, 0);
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      duration = 2.0;
    }

    // Denser frame sampling (every 0.45s, up to 36 samples) so quick sweeps over 3+ labels never skip a label
    const maxSamples = 36;
    const stepSec = Math.max(0.45, duration / maxSamples);
    const sampleTimes: number[] = [];
    for (let t = Math.min(0.15, duration * 0.08); t < duration; t += stepSec) {
      sampleTimes.push(Number(t.toFixed(2)));
    }
    if (sampleTimes.length === 0) {
      sampleTimes.push(0);
    }

    const rawCandidates: Array<{
      canvas: HTMLCanvasElement;
      timestampSec: number;
      sharpness: number;
      signature: Uint8Array;
    }> = [];

    for (let i = 0; i < sampleTimes.length; i++) {
      const t = sampleTimes[i];
      onProgress?.({
        phase: 'extracting-frames',
        percent: Math.round(5 + ((i + 1) / sampleTimes.length) * 18),
        message: `Plockar ut bildrutor ur videon (${i + 1}/${sampleTimes.length})...`,
        currentFrame: i + 1,
        totalFrames: sampleTimes.length,
      });

      await seekVideoTo(video, t);
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) continue;

      const scale = Math.min(1, 1800 / Math.max(vw, vh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vw * scale));
      canvas.height = Math.max(1, Math.round(vh * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const { sharpness, signature } = computeCanvasSharpness(canvas);
      rawCandidates.push({
        canvas,
        timestampSec: t,
        sharpness,
        signature,
      });
    }

    if (rawCandidates.length <= 3) {
      return rawCandidates.map(({ canvas, timestampSec, signature }) => ({
        canvas,
        timestampSec,
        signature,
      }));
    }

    // Keep all reasonably sharp frames (only drop severe motion blur below 38% of median)
    const sortedSharp = [...rawCandidates].map((c) => c.sharpness).sort((a, b) => a - b);
    const medianSharpness = sortedSharp[Math.floor(sortedSharp.length / 2)] || 1;
    const minAcceptableSharpness = medianSharpness * 0.38;

    const filtered = rawCandidates.filter((c) => c.sharpness >= minAcceptableSharpness);
    return (filtered.length > 0 ? filtered : rawCandidates).map(
      ({ canvas, timestampSec, signature }) => ({
        canvas,
        timestampSec,
        signature,
      })
    );
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function buildSummaryNote(
  items: InventoryItem[],
  scannedFrameCount: number,
  modeLabel: string
): string {
  const reviewCount = items.filter((i) => i.needsReview).length;
  const base = `Analyserad lokalt på enheten (${modeLabel}, ${scannedFrameCount} ${
    scannedFrameCount === 1 ? 'bild' : 'bildrutor'
  }) utan API.`;
  if (reviewCount > 0) {
    return `${base} Kontrollera ${reviewCount} rad${reviewCount > 1 ? 'er' : ''} markerad med "Kontrollera".`;
  }
  return base;
}

export async function scanCapturedCameraFramesLocally(
  frames: CapturedCameraFrame[],
  options?: {
    hint?: string;
    onProgress?: (progress: ScanProgress) => void;
  }
): Promise<LocalScanResult> {
  if (frames.length === 0) {
    throw new Error('Inga kamerarutor fångades. Håll kameran mot etiketten i minst 1–2 sekunder.');
  }

  options?.onProgress?.({
    phase: 'loading-engine',
    percent: 12,
    message: 'Startar lokal streckkods- & OCR-motor...',
  });

  const worker = await getLocalOcrWorker((msg) => {
    options?.onProgress?.({
      phase: 'loading-engine',
      percent: 20,
      message: msg,
    });
  });

  const slices: VideoFrameDetectionSlice[] = [];
  let prevSignature: Uint8Array | null = null;
  let prevPackages: RawDetectedPackage[] = [];
  let runningFoundCount = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    options?.onProgress?.({
      phase: 'scanning',
      percent: Math.round(25 + ((i + 1) / frames.length) * 70),
      message: `Läser bildruta ${i + 1} av ${frames.length}${
        runningFoundCount > 0 ? ` · ${runningFoundCount} fynd` : ''
      }...`,
      currentFrame: i + 1,
      totalFrames: frames.length,
      foundSoFar: runningFoundCount,
    });

    const { signature } = computeCanvasSharpness(frame.canvas);
    if (prevSignature && signatureMeanDiff(prevSignature, signature) < 1.8) {
      slices.push({
        frameIndex: i,
        timestampSec: frame.timestampSec,
        packages: prevPackages,
      });
      continue;
    }

    const detected = await analyzeSingleCanvasFrame(
      worker,
      frame.canvas,
      i,
      frames.length === 1 ? 'image' : 'video-frame',
      frame.timestampSec,
      options?.hint
    );

    prevSignature = signature;
    prevPackages = detected;
    if (detected.length > 0) {
      runningFoundCount = aggregateVideoFrameDetections([
        ...slices,
        { frameIndex: i, timestampSec: frame.timestampSec, packages: detected },
      ]).reduce((sum, p) => sum + (p.quantity ?? 1), 0);
    }

    slices.push({
      frameIndex: i,
      timestampSec: frame.timestampSec,
      packages: detected,
    });
  }

  const rawPackages =
    frames.length === 1 ? slices[0]?.packages ?? [] : aggregateVideoFrameDetections(slices);

  const items = mergeInventoryItems([], rawPackages);
  return {
    items,
    rawPackages,
    summaryNote: buildSummaryNote(items, frames.length, 'kamera'),
  };
}

export async function scanMediaFilesLocally(
  files: File[],
  options?: {
    hint?: string;
    onProgress?: (progress: ScanProgress) => void;
  }
): Promise<LocalScanResult> {
  if (!files || files.length === 0) {
    throw new Error('Välj eller spela in minst en video eller bild först.');
  }

  options?.onProgress?.({
    phase: 'preparing',
    percent: 5,
    message: 'Förbereder lokal bild- och videoanalys...',
  });

  const imageFiles = files.filter((f) => f.type.startsWith('image/'));
  const videoFiles = files.filter((f) => f.type.startsWith('video/'));

  if (imageFiles.length === 0 && videoFiles.length === 0) {
    throw new Error('Endast video- (MP4, MOV, WebM) och bildfiler (JPG, PNG, WebP) stöds.');
  }

  const videoFramesByFile: Array<
    Array<{ canvas: HTMLCanvasElement; timestampSec: number; signature: Uint8Array }>
  > = [];
  for (const vf of videoFiles) {
    const extracted = await extractFramesFromVideoFile(vf, options?.onProgress);
    videoFramesByFile.push(extracted);
  }

  const imageCanvases: HTMLCanvasElement[] = [];
  for (const imgFile of imageFiles) {
    const canvas = await loadImageFileToCanvas(imgFile);
    imageCanvases.push(canvas);
  }

  const totalUnits =
    imageCanvases.length + videoFramesByFile.reduce((sum, list) => sum + list.length, 0);

  if (totalUnits === 0) {
    throw new Error('Kunde inte läsa ut några bildrutor från det valda materialet.');
  }

  options?.onProgress?.({
    phase: 'loading-engine',
    percent: 25,
    message: 'Startar lokal streckkods- & OCR-motor (100 % gratis & offline)...',
  });

  const worker = await getLocalOcrWorker((msg) => {
    options?.onProgress?.({
      phase: 'loading-engine',
      percent: 28,
      message: msg,
    });
  });

  const allRawPackages: RawDetectedPackage[] = [];
  let completedUnits = 0;

  for (let i = 0; i < imageCanvases.length; i++) {
    completedUnits++;
    options?.onProgress?.({
      phase: 'scanning',
      percent: Math.round(30 + (completedUnits / totalUnits) * 66),
      message: `Beskär etikett & läser bild ${i + 1} av ${imageCanvases.length}...`,
      currentFrame: completedUnits,
      totalFrames: totalUnits,
      foundSoFar: allRawPackages.length,
    });

    const detected = await analyzeSingleCanvasFrame(
      worker,
      imageCanvases[i],
      i,
      'image',
      undefined,
      options?.hint
    );
    allRawPackages.push(...detected);
  }

  for (const frames of videoFramesByFile) {
    const slices: VideoFrameDetectionSlice[] = [];
    let prevSignature: Uint8Array | null = null;
    let prevPackages: RawDetectedPackage[] = [];

    for (let i = 0; i < frames.length; i++) {
      completedUnits++;
      const frame = frames[i];

      options?.onProgress?.({
        phase: 'scanning',
        percent: Math.round(30 + (completedUnits / totalUnits) * 66),
        message: `Läser videoruta ${i + 1} av ${frames.length}...`,
        currentFrame: completedUnits,
        totalFrames: totalUnits,
      });

      if (prevSignature && signatureMeanDiff(prevSignature, frame.signature) < 1.8) {
        slices.push({
          frameIndex: i,
          timestampSec: frame.timestampSec,
          packages: prevPackages,
        });
        continue;
      }

      const detected = await analyzeSingleCanvasFrame(
        worker,
        frame.canvas,
        i,
        'video-frame',
        frame.timestampSec,
        options?.hint
      );

      prevSignature = frame.signature;
      prevPackages = detected;
      slices.push({
        frameIndex: i,
        timestampSec: frame.timestampSec,
        packages: detected,
      });
    }

    const aggregated = aggregateVideoFrameDetections(slices);
    allRawPackages.push(...aggregated);
  }

  options?.onProgress?.({
    phase: 'finalizing',
    percent: 98,
    message: 'Kategoriserar och slår ihop dubbletter...',
  });

  const items = mergeInventoryItems([], allRawPackages);
  return {
    items,
    rawPackages: allRawPackages,
    summaryNote: buildSummaryNote(items, totalUnits, 'uppladdad media'),
  };
}

export async function createSampleShippingLabelFile(variant = 0): Promise<File> {
  ensureZXingWriterConfigured();

  const presets = [
    {
      customer: 'Microsoft',
      type: 'DELIVERY',
      ref: 'Del001234567',
      barcode: '7310012345678',
      dest: 'Kista Datacenter Gate 4, 164 40 Kista',
    },
    {
      customer: 'Google',
      type: 'REMOVAL',
      ref: 'Rem004891203',
      barcode: '7350048912034',
      dest: 'Nordic Logistics Hub, Stockholm',
    },
    {
      customer: 'ABB',
      type: 'DELIVERY',
      ref: 'Del009845120',
      barcode: '7310098451209',
      dest: 'Industrigatan 12, Västerås',
    },
  ];
  const sample = presets[variant % presets.length];

  const canvas = document.createElement('canvas');
  canvas.width = 920;
  canvas.height = 620;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#a89478'; // Realistic brown cardboard surround to test label auto-crop!
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(90, 62, 740, 496);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 4;
  ctx.strokeRect(90, 62, 740, 496);

  ctx.beginPath();
  ctx.moveTo(90, 170);
  ctx.lineTo(830, 170);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 42px Arial, sans-serif';
  ctx.fillText(`Kund: ${sample.customer}`, 118, 132);

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(580, 86, 224, 62);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(sample.type, 692, 128);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#334155';
  ctx.font = '22px Arial, sans-serif';
  ctx.fillText(`Mottagare: ${sample.dest}`, 118, 220);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 50px monospace';
  ctx.fillText(sample.ref, 118, 302);

  ctx.beginPath();
  ctx.moveTo(118, 336);
  ctx.lineTo(802, 336);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.stroke();

  try {
    const written = await writeBarcode(sample.barcode, {
      format: 'Code128',
      scale: 4,
      addHRT: false,
    });
    if (written.image) {
      const bmp = await createImageBitmap(written.image);
      ctx.drawImage(bmp, 170, 360, 580, 122);
      bmp.close();
    } else if (written.symbol?.data && written.symbol.width > 0 && written.symbol.height > 0) {
      const { data: gray, width: sw, height: sh } = written.symbol;
      const barCanvas = document.createElement('canvas');
      barCanvas.width = sw;
      barCanvas.height = sh;
      const barCtx = barCanvas.getContext('2d');
      if (barCtx) {
        const imgData = barCtx.createImageData(sw, sh);
        for (let i = 0; i < sw * sh; i++) {
          const v = gray[i];
          imgData.data[i * 4] = v;
          imgData.data[i * 4 + 1] = v;
          imgData.data[i * 4 + 2] = v;
          imgData.data[i * 4 + 3] = 255;
        }
        barCtx.putImageData(imgData, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(barCanvas, 170, 360, 580, 122);
        ctx.imageSmoothingEnabled = true;
      }
    }
  } catch {
    // Fallback text below
  }

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(sample.barcode, 460, 526);
  ctx.textAlign = 'left';

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Kunde inte skapa testetikett'))),
      'image/png'
    );
  });

  return new File([blob], `testetikett-${sample.ref}.png`, { type: 'image/png' });
}
