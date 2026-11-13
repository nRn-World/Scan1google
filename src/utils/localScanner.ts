import Tesseract from 'tesseract.js';
import { simd } from 'wasm-feature-detect';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import {
  prepareZXingModule as prepareZXingWriterModule,
  writeBarcode,
} from 'zxing-wasm/writer';
import { mergeInventoryItems, type InventoryItem, type RawDetectedPackage } from './inventory';
import {
  aggregateVideoFrameDetections,
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
  timestampSec: number;
  sharpness: number;
}

export interface LocalScanResult {
  items: InventoryItem[];
  rawPackages: RawDetectedPackage[];
  summaryNote: string;
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
            if (onProgress && msg.status) {
              if (msg.status.includes('loading')) {
                onProgress('Laddar lokal OCR-modell (sparas offline på enheten)...');
              }
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

  // Downsample to 24x18 signature for quick static-frame similarity detection
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

function signatureMeanDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
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

function createEnhancedOcrCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const maxDim = Math.max(source.width, source.height);
  let scale = 1;
  if (maxDim > 1800) {
    scale = 1800 / maxDim;
  } else if (maxDim < 950) {
    scale = Math.min(2.2, 1400 / Math.max(1, maxDim));
  }

  const innerW = Math.max(1, Math.round(source.width * scale));
  const innerH = Math.max(1, Math.round(source.height * scale));
  const pad = 18;

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
  const hist = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    hist[lum]++;
  }

  const lowTarget = Math.floor(pixelCount * 0.02);
  const highTarget = Math.floor(pixelCount * 0.98);
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

  const range = Math.max(45, high - low);
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    const stretched = Math.max(0, Math.min(255, Math.round(((lum - low) * 255) / range)));
    data[i] = stretched;
    data[i + 1] = stretched;
    data[i + 2] = stretched;
  }

  ctx.putImageData(imgData, pad, pad);
  return canvas;
}

async function detectBarcodesInCanvas(canvas: HTMLCanvasElement): Promise<DetectedBarcodeRead[]> {
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
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

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
      // Continue to native BarcodeDetector fallback if WASM encounters an edge case
    }
  }

  const nativeDetector = getNativeBarcodeDetector();
  if (nativeDetector) {
    try {
      const nativeHits = await nativeDetector.detect(canvas);
      for (const hit of nativeHits) {
        if (!hit.rawValue || !hit.rawValue.trim()) continue;
        results.push({
          text: hit.rawValue.trim(),
          format: hit.format || 'Barcode',
          position: hit.boundingBox
            ? {
                x: hit.boundingBox.x,
                y: hit.boundingBox.y,
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

function extractOcrLines(page: Tesseract.Page): OcrLineBox[] {
  const lines: OcrLineBox[] = [];
  if (!page.blocks) return lines;

  for (const block of page.blocks) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const text = (line.text ?? '').trim();
        if (!text) continue;
        lines.push({
          text,
          confidence: line.confidence,
          bbox: line.bbox,
        });
      }
    }
  }
  return lines;
}

async function recognizeCanvasOcr(
  worker: Tesseract.Worker,
  canvas: HTMLCanvasElement
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
  return {
    text: data.text ?? '',
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    lines: extractOcrLines(data),
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
  const barcodes = await detectBarcodesInCanvas(canvas);
  const ocr = await recognizeCanvasOcr(worker, canvas);

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

  // If upright OCR found no reference code (or no customer) and a barcode was sideways (90/180/270 deg),
  // rotate upright and re-read text so sideways phone photos still extract full customer + Del/Rem details.
  const rotatedBarcode = barcodes.find(
    (b) => b.rotation === 90 || b.rotation === 180 || b.rotation === 270
  );
  const needsRotatedRetry =
    rotatedBarcode &&
    (packages.length === 0 ||
      (packages.every((p) => p.customer === 'Okänd kund') && ocr.confidence < 55));

  if (needsRotatedRetry && rotatedBarcode?.rotation) {
    const correctedCanvas = rotateCanvas(canvas, 360 - rotatedBarcode.rotation);
    const rotatedOcr = await recognizeCanvasOcr(worker, correctedCanvas);
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
      // Fallback to HTMLImageElement below
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

    // Resolve Chrome MediaRecorder WebM Infinity duration quirk
    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      await seekVideoTo(video, 1e8);
      duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : video.currentTime;
      await seekVideoTo(video, 0);
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      duration = 2.0;
    }

    const maxSamples = 24;
    const stepSec = Math.max(0.75, duration / maxSamples);
    const sampleTimes: number[] = [];
    for (let t = Math.min(0.2, duration * 0.1); t < duration; t += stepSec) {
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

      const scale = Math.min(1, 1600 / Math.max(vw, vh));
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

    if (rawCandidates.length <= 2) {
      return rawCandidates.map(({ canvas, timestampSec, signature }) => ({
        canvas,
        timestampSec,
        signature,
      }));
    }

    // Filter out heavily motion-blurred pan frames (below 45% of median sharpness)
    const sortedSharp = [...rawCandidates].map((c) => c.sharpness).sort((a, b) => a - b);
    const medianSharpness = sortedSharp[Math.floor(sortedSharp.length / 2)] || 1;
    const minAcceptableSharpness = medianSharpness * 0.45;

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

export function captureVideoElementFrame(
  videoEl: HTMLVideoElement,
  timestampSec: number
): CapturedCameraFrame | null {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(1, 1600 / Math.max(vw, vh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vw * scale));
  canvas.height = Math.max(1, Math.round(vh * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  const { sharpness } = computeCanvasSharpness(canvas);
  return {
    canvas,
    timestampSec,
    sharpness,
  };
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

  // Filter out severe motion blur if multiple frames exist
  let candidates = frames;
  if (frames.length > 3) {
    const sorted = [...frames].map((f) => f.sharpness).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    const sharpEnough = frames.filter((f) => f.sharpness >= median * 0.45);
    if (sharpEnough.length > 0) {
      candidates = sharpEnough;
    }
  }

  const slices: VideoFrameDetectionSlice[] = [];
  let prevSignature: Uint8Array | null = null;
  let prevPackages: RawDetectedPackage[] = [];
  let runningFoundCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const frame = candidates[i];
    options?.onProgress?.({
      phase: 'scanning',
      percent: Math.round(25 + ((i + 1) / candidates.length) * 70),
      message: `Läser bildruta ${i + 1} av ${candidates.length}${
        runningFoundCount > 0 ? ` · ${runningFoundCount} fynd` : ''
      }...`,
      currentFrame: i + 1,
      totalFrames: candidates.length,
      foundSoFar: runningFoundCount,
    });

    const { signature } = computeCanvasSharpness(frame.canvas);
    // Reuse result if camera was held completely motionless since previous frame
    if (prevSignature && signatureMeanDiff(prevSignature, signature) < 2.2) {
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
    candidates.length === 1
      ? slices[0]?.packages ?? []
      : aggregateVideoFrameDetections(slices);

  const items = mergeInventoryItems([], rawPackages);
  return {
    items,
    rawPackages,
    summaryNote: buildSummaryNote(items, candidates.length, 'kamera'),
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

  // Extract frames from any uploaded videos first
  const videoFramesByFile: Array<
    Array<{ canvas: HTMLCanvasElement; timestampSec: number; signature: Uint8Array }>
  > = [];
  for (const vf of videoFiles) {
    const extracted = await extractFramesFromVideoFile(vf, options?.onProgress);
    videoFramesByFile.push(extracted);
  }

  // Load any uploaded still images
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

  // 1. Scan uploaded still images (each image file is an independent photo)
  for (let i = 0; i < imageCanvases.length; i++) {
    completedUnits++;
    options?.onProgress?.({
      phase: 'scanning',
      percent: Math.round(30 + (completedUnits / totalUnits) * 66),
      message: `Läser bild ${i + 1} av ${imageCanvases.length}...`,
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

  // 2. Scan extracted frames per video file with temporal deduplication
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

      if (prevSignature && signatureMeanDiff(prevSignature, frame.signature) < 2.2) {
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

/**
 * Generates a realistic synthetic shipping label PNG image (with a real Code128 barcode + printed text)
 * so the user can test the 100% local ZXing + Tesseract OCR scanner on real pixels with one click.
 */
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

  // White shipping label card on subtle cardboard background
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(36, 32, 848, 556);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 4;
  ctx.strokeRect(36, 32, 848, 556);

  // Header divider
  ctx.beginPath();
  ctx.moveTo(36, 150);
  ctx.lineTo(884, 150);
  ctx.lineWidth = 3;
  ctx.stroke();

  // Customer Name
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 46px Arial, sans-serif';
  ctx.fillText(`Kund: ${sample.customer}`, 66, 108);

  // Type Badge
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(620, 58, 234, 68);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(sample.type, 737, 104);
  ctx.textAlign = 'left';

  // Destination metadata
  ctx.fillStyle = '#334155';
  ctx.font = '24px Arial, sans-serif';
  ctx.fillText(`Mottagare: ${sample.dest}`, 66, 205);

  // Prominent Del / Rem Reference Number
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 54px monospace';
  ctx.fillText(sample.ref, 66, 295);

  // Divider before barcode
  ctx.beginPath();
  ctx.moveTo(66, 335);
  ctx.lineTo(854, 335);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Real Code128 barcode rendered via zxing-wasm/writer
  try {
    const written = await writeBarcode(sample.barcode, {
      format: 'Code128',
      scale: 4,
      addHRT: false,
    });
    if (written.image) {
      const bmp = await createImageBitmap(written.image);
      ctx.drawImage(bmp, 150, 365, 620, 130);
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
        ctx.drawImage(barCanvas, 150, 365, 620, 130);
        ctx.imageSmoothingEnabled = true;
      }
    }
  } catch {
    // Even if barcode writer fails, human-readable text below is still drawn
  }

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(sample.barcode, 460, 540);
  ctx.textAlign = 'left';

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Kunde inte skapa testetikett'))), 'image/png');
  });

  return new File([blob], `testetikett-${sample.ref}.png`, { type: 'image/png' });
}
