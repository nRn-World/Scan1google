import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  FileVideo,
  Loader2,
  Play,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Square,
  Upload,
  Video,
  AlertCircle,
} from 'lucide-react';
import type { RawDetectedPackage, InventoryItem } from '../utils/inventory';
import {
  captureVideoElementFrame,
  createSampleShippingLabelFile,
  scanCapturedCameraFramesLocally,
  scanMediaFilesLocally,
  type CapturedCameraFrame,
  type ScanProgress,
} from '../utils/localScanner';

type InputMode = 'camera' | 'upload';

interface VideoScannerPanelProps {
  appendMode: boolean;
  onToggleAppendMode: (append: boolean) => void;
  onScanComplete: (
    items: InventoryItem[],
    source: 'camera' | 'upload',
    summaryNote: string
  ) => void;
  onLoadDemo: (raw?: RawDetectedPackage[]) => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function VideoScannerPanel({
  appendMode,
  onToggleAppendMode,
  onScanComplete,
  onLoadDemo,
}: VideoScannerPanelProps) {
  const [inputMode, setInputMode] = useState<InputMode>('camera');
  const [cameraActive, setCameraActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [capturedFrameCount, setCapturedFrameCount] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [recordedPreviewUrl, setRecordedPreviewUrl] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sampleVariant, setSampleVariant] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const capturedFramesRef = useRef<CapturedCameraFrame[]>([]);
  const recordingStartMsRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const frameCaptureTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopStream = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (frameCaptureTimerRef.current) {
      window.clearInterval(frameCaptureTimerRef.current);
      frameCaptureTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setRecording(false);
  };

  useEffect(() => {
    return () => {
      stopStream();
      if (recordedPreviewUrl) {
        URL.revokeObjectURL(recordedPreviewUrl);
      }
    };
  }, [recordedPreviewUrl]);

  const startCamera = async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErrorMsg(
        'Webbläsaren saknar direkt kamerastöd här. Byt till fliken "Ladda upp video/bild" eller testa lokal skanner på exempeletikett.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
    } catch {
      setErrorMsg(
        'Kunde inte starta kameran. Kontrollera kamerabehörighet i webbläsaren eller ladda upp en inspelad video/bild.'
      );
    }
  };

  const analyzeFilesLocally = async (filesToScan: File[], source: 'camera' | 'upload') => {
    setAnalyzing(true);
    setErrorMsg(null);
    setScanProgress({
      phase: 'preparing',
      percent: 5,
      message: 'Förbereder lokal avläsning på enheten...',
    });

    try {
      const result = await scanMediaFilesLocally(filesToScan, {
        hint: hint.trim() || undefined,
        onProgress: setScanProgress,
      });

      if (result.items.length === 0) {
        setErrorMsg(
          'Inga tydliga deliverynummer eller streckkoder hittades i bilden/videon. Försök hålla kameran närmare etiketten i bättre ljus.'
        );
        return;
      }

      onScanComplete(result.items, source, result.summaryNote);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Ett fel uppstod vid lokal avläsning.'
      );
    } finally {
      setAnalyzing(false);
      setScanProgress(null);
    }
  };

  const analyzeCapturedFrames = async (frames: CapturedCameraFrame[], fallbackVideoFile?: File) => {
    if (frames.length === 0 && fallbackVideoFile) {
      await analyzeFilesLocally([fallbackVideoFile], 'camera');
      return;
    }

    setAnalyzing(true);
    setErrorMsg(null);
    setScanProgress({
      phase: 'preparing',
      percent: 8,
      message: 'Analyserar kamerarutor lokalt på enheten...',
    });

    try {
      const result = await scanCapturedCameraFramesLocally(frames, {
        hint: hint.trim() || undefined,
        onProgress: setScanProgress,
      });

      if (result.items.length === 0) {
        setErrorMsg(
          'Inga tydliga deliverynummer eller streckkoder hittades. Håll varje etikett stilla i 1–2 sekunder i bra ljus.'
        );
        return;
      }

      onScanComplete(result.items, 'camera', result.summaryNote);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Ett fel uppstod vid lokal kameraanalys.'
      );
    } finally {
      setAnalyzing(false);
      setScanProgress(null);
    }
  };

  const handleInstantSnapshotScan = async () => {
    if (!videoRef.current || !cameraActive) return;
    const snap = captureVideoElementFrame(videoRef.current, 0);
    if (!snap) {
      setErrorMsg('Kameran är inte redo ännu — vänta ett ögonblick och försök igen.');
      return;
    }
    stopStream();
    await analyzeCapturedFrames([snap]);
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    setErrorMsg(null);
    chunksRef.current = [];
    capturedFramesRef.current = [];
    setCapturedFrameCount(0);
    setRecordingSeconds(0);
    recordingStartMsRef.current = Date.now();

    const grabCurrentLiveFrame = () => {
      if (!videoRef.current) return;
      const elapsedSec = (Date.now() - recordingStartMsRef.current) / 1000;
      const frame = captureVideoElementFrame(videoRef.current, elapsedSec);
      if (frame && capturedFramesRef.current.length < 40) {
        capturedFramesRef.current.push(frame);
        setCapturedFrameCount(capturedFramesRef.current.length);
      }
    };

    // Capture initial frame immediately and every 850ms during sweep
    grabCurrentLiveFrame();
    frameCaptureTimerRef.current = window.setInterval(grabCurrentLiveFrame, 850);

    const candidateTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    const supportedType = candidateTypes.find(
      (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)
    );

    try {
      const recorder = supportedType
        ? new MediaRecorder(streamRef.current, {
            mimeType: supportedType,
            videoBitsPerSecond: 2_500_000,
          })
        : new MediaRecorder(streamRef.current);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const framesSnapshot = [...capturedFramesRef.current];
        capturedFramesRef.current = [];

        const mime = recorder.mimeType || 'video/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        stopStream();

        if (framesSnapshot.length === 0 && blob.size === 0) {
          setErrorMsg('Inspelningen blev tom. Försök filma minst 2–3 sekunder.');
          return;
        }

        let fallbackFile: File | undefined;
        if (blob.size > 0) {
          const ext = mime.includes('mp4') ? 'mp4' : 'webm';
          fallbackFile = new File([blob], `inventering-${Date.now()}.${ext}`, {
            type: mime,
          });
          if (recordedPreviewUrl) {
            URL.revokeObjectURL(recordedPreviewUrl);
          }
          setRecordedPreviewUrl(URL.createObjectURL(blob));
        }

        void analyzeCapturedFrames(framesSnapshot, fallbackFile);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(500);
      setRecording(true);

      timerRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch {
      // Fallback if MediaRecorder is unsupported: rely purely on live canvas frame capture
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    }
  };

  const stopRecordingAndProcess = () => {
    if (videoRef.current) {
      const elapsedSec = (Date.now() - recordingStartMsRef.current) / 1000;
      const finalFrame = captureVideoElementFrame(videoRef.current, elapsedSec);
      if (finalFrame && capturedFramesRef.current.length < 40) {
        capturedFramesRef.current.push(finalFrame);
      }
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      const framesSnapshot = [...capturedFramesRef.current];
      capturedFramesRef.current = [];
      stopStream();
      void analyzeCapturedFrames(framesSnapshot);
    }
  };

  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg(null);
    const validFiles = Array.from(fileList).filter(
      (f) => f.type.startsWith('video/') || f.type.startsWith('image/')
    );
    if (validFiles.length === 0) {
      setErrorMsg('Välj minst en video (MP4, MOV, WebM) eller bildfil (JPG, PNG, WebP).');
      return;
    }
    setSelectedFiles(validFiles);
  };

  const handleUploadSubmit = () => {
    if (selectedFiles.length === 0) {
      setErrorMsg('Välj en video eller etikettbild först.');
      return;
    }
    void analyzeFilesLocally(selectedFiles, 'upload');
  };

  const handleTestLocalScannerOnSampleLabel = async () => {
    setErrorMsg(null);
    setAnalyzing(true);
    setScanProgress({
      phase: 'preparing',
      percent: 6,
      message: 'Skapar riktig etikettbild med streckkod och kör lokal OCR...',
    });

    try {
      const currentVariant = sampleVariant;
      setSampleVariant((v) => v + 1);
      const sampleFile = await createSampleShippingLabelFile(currentVariant);
      const result = await scanMediaFilesLocally([sampleFile], {
        hint: hint.trim() || undefined,
        onProgress: setScanProgress,
      });

      if (result.items.length > 0) {
        onScanComplete(result.items, 'upload', result.summaryNote);
      } else {
        onLoadDemo();
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Kunde inte köra lokal testskanning.'
      );
    } finally {
      setAnalyzing(false);
      setScanProgress(null);
    }
  };

  return (
    <section
      aria-labelledby="scanner-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            <span>100 % Lokal Streckkod + OCR · Gratis &amp; Offline · Inget API</span>
          </div>
          <h1
            id="scanner-heading"
            className="mt-2 font-display text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl"
          >
            Filma paket till Excel
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Filma eller fota alla delivery- och removalpaket. Streckkoder, kund, typ, nummer och
            antal läses av direkt på din enhet utan moln-API.
          </p>
        </div>

        {/* Input Mode Switch */}
        <div
          role="tablist"
          aria-label="Välj inmatningsmetod"
          className="inline-flex self-start rounded-lg bg-slate-100 p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={inputMode === 'camera'}
            onClick={() => {
              setInputMode('camera');
              setErrorMsg(null);
            }}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
              inputMode === 'camera'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Camera className="h-4 w-4" aria-hidden="true" />
            <span>Filma direkt</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={inputMode === 'upload'}
            onClick={() => {
              stopStream();
              setInputMode('upload');
              setErrorMsg(null);
            }}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
              inputMode === 'upload'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            <span>Ladda upp video/bild</span>
          </button>
        </div>
      </div>

      {/* Main Viewport Area */}
      <div className="mt-5 grid gap-6 lg:grid-cols-12 lg:items-stretch">
        <div className="lg:col-span-8 flex flex-col">
          {inputMode === 'camera' ? (
            <div className="relative flex min-h-[300px] sm:min-h-[380px] lg:h-full w-full flex-col items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950 text-white">
              <video
                ref={videoRef}
                playsInline
                muted
                className={`h-full w-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
              />

              {/* Subtle reticle frame when camera is live */}
              {cameraActive && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-6 rounded-lg border border-white/25"
                />
              )}

              {/* Live Recording Telemetry */}
              {recording && (
                <div className="absolute top-4 left-4 flex items-center gap-2 rounded-md bg-slate-950/85 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse"
                  />
                  <span>SPELAR IN</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {formatDuration(recordingSeconds)}
                  </span>
                  {capturedFrameCount > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-sky-300">{capturedFrameCount} rutor</span>
                    </>
                  )}
                </div>
              )}

              {/* Idle Placeholder State */}
              {!cameraActive && !analyzing && (
                <div className="flex flex-col items-center px-6 py-8 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-800 text-sky-400">
                    <Video className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <h2 className="mt-4 font-display text-lg font-semibold text-white">
                    Redo att filma paket &amp; streckkoder lokalt
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-slate-300">
                    Starta kameran och svep lugnt över varje fraktetikett. Avläsningen sker helt
                    gratis direkt i din telefon/webbläsare utan internetkrav.
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={startCamera}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                    >
                      <Camera className="h-4 w-4" aria-hidden="true" />
                      <span>Starta kamera</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleTestLocalScannerOnSampleLabel()}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-950/60 px-4 py-2.5 text-sm font-medium text-sky-200 transition-colors hover:bg-sky-900/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                    >
                      <ScanLine className="h-4 w-4 text-sky-400" aria-hidden="true" />
                      <span>Testa lokal OCR på etikett</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onLoadDemo()}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                    >
                      <Sparkles className="h-4 w-4 text-sky-400" aria-hidden="true" />
                      <span>Ladda exempel-lista</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Processing State Overlay */}
              {analyzing && (
                <div
                  role="status"
                  aria-live="polite"
                  className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 px-6 text-center backdrop-blur-xs"
                >
                  <Loader2 className="h-9 w-9 animate-spin text-sky-400" aria-hidden="true" />
                  <p className="mt-4 font-display text-lg font-semibold text-white">
                    {scanProgress?.message || 'Läser av streckkoder och deliverynummer lokalt...'}
                  </p>
                  <p className="mt-1 max-w-sm text-xs text-slate-300">
                    Körs helt på din enhet (ZXing streckkodsläsare + Tesseract OCR) — ingen data skickas iväg.
                  </p>
                  {scanProgress && (
                    <div className="mt-4 w-full max-w-xs overflow-hidden rounded-full bg-slate-800 h-2">
                      <div
                        className="h-full bg-sky-500 transition-all duration-300"
                        style={{ width: `${Math.max(5, Math.min(100, scanProgress.percent))}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Camera Controls Bar */}
              {cameraActive && !analyzing && (
                <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-3 bg-gradient-to-t from-black/85 via-black/55 to-transparent p-4">
                  <button
                    type="button"
                    onClick={stopStream}
                    className="inline-flex min-h-[44px] items-center rounded-lg border border-white/20 bg-slate-900/80 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    Stäng kamera
                  </button>

                  {!recording ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleInstantSnapshotScan()}
                        className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-white/25 bg-slate-900/85 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        <ScanLine className="h-4 w-4 text-sky-400" aria-hidden="true" />
                        <span>Fota 1 etikett</span>
                      </button>
                      <button
                        type="button"
                        onClick={startRecording}
                        className="inline-flex min-h-[48px] items-center gap-2 rounded-lg bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-500"
                      >
                        <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                        <span>Starta filmning</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={stopRecordingAndProcess}
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-lg bg-red-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-500"
                    >
                      <Square className="h-4 w-4 fill-current" aria-hidden="true" />
                      <span>Avsluta &amp; skapa Excel</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* Upload Video / Images Mode */
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                handleFilesSelected(e.dataTransfer.files);
              }}
              className={`relative flex min-h-[300px] sm:min-h-[380px] lg:h-full w-full flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
                dragActive
                  ? 'border-sky-600 bg-sky-50'
                  : 'border-slate-300 bg-slate-50 hover:border-slate-400'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,image/*"
                multiple
                aria-label="Välj video eller bildfil att skanna"
                onChange={(e) => handleFilesSelected(e.target.files)}
                className="sr-only"
              />

              {analyzing ? (
                <div role="status" aria-live="polite" className="flex flex-col items-center">
                  <Loader2 className="h-9 w-9 animate-spin text-sky-600" aria-hidden="true" />
                  <p className="mt-4 font-display text-lg font-semibold text-slate-900">
                    {scanProgress?.message || 'Analyserar uppladdat material lokalt...'}
                  </p>
                  <p className="mt-1 max-w-sm text-xs text-slate-600">
                    Extraherar streckkoder, kund, Delivery/Removal-typ och exakta siffror direkt i webbläsaren.
                  </p>
                  {scanProgress && (
                    <div className="mt-4 w-64 overflow-hidden rounded-full bg-slate-200 h-2">
                      <div
                        className="h-full bg-sky-600 transition-all duration-300"
                        style={{ width: `${Math.max(5, Math.min(100, scanProgress.percent))}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white border border-slate-200 text-sky-600">
                    <FileVideo className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <h2 className="mt-4 font-display text-lg font-semibold text-slate-900">
                    Släpp video eller paketbilder här
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-slate-600">
                    Stöder MP4, MOV, WebM samt JPG/PNG-foton av fraktetiketter. All analys sker
                    lokalt på din enhet utan storleks- eller API-gräns.
                  </p>

                  {selectedFiles.length > 0 && (
                    <div className="mt-4 w-full max-w-md rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-left text-xs text-slate-700">
                      <p className="font-semibold text-slate-900">
                        Valda filer ({selectedFiles.length} st):
                      </p>
                      <ul className="mt-1 space-y-0.5 truncate font-mono">
                        {selectedFiles.slice(0, 4).map((file) => (
                          <li key={file.name + file.size} className="truncate">
                            {file.name} · {(file.size / (1024 * 1024)).toFixed(2)} MB
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
                    >
                      <Upload className="h-4 w-4" aria-hidden="true" />
                      <span>Välj fil från enhet</span>
                    </button>

                    {selectedFiles.length > 0 ? (
                      <button
                        type="button"
                        onClick={handleUploadSubmit}
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700"
                      >
                        <span>Analysera lokalt &amp; skapa lista</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleTestLocalScannerOnSampleLabel()}
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm font-medium text-sky-800 hover:bg-sky-100"
                      >
                        <ScanLine className="h-4 w-4 text-sky-600" aria-hidden="true" />
                        <span>Testa på genererad etikettbild</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Right Side Configuration & Accuracy Guide */}
        <aside className="lg:col-span-4 flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div className="space-y-5">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                Inställningar för avläsning
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                Styr hur nya filmningar och foton slås ihop med din nuvarande Excel-lista.
              </p>
            </div>

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-950">
              <p className="font-semibold text-emerald-900">
                Lokal motor aktiv (0 kr / utan API)
              </p>
              <p className="mt-1 text-emerald-800 leading-relaxed">
                Kombinerar <strong>ZXing WASM</strong> (1D/2D-streckkoder &amp; QR) med{' '}
                <strong>Tesseract LSTM OCR</strong> (svenska + engelska) direkt på enheten. Fungerar
                helt offline i både webbläsare och Android-APK.
              </p>
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-semibold text-slate-700">
                Hantering av lista
              </span>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-200/70 p-1">
                <button
                  type="button"
                  onClick={() => onToggleAppendMode(true)}
                  className={`min-h-[40px] rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    appendMode
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Lägg till i listan
                </button>
                <button
                  type="button"
                  onClick={() => onToggleAppendMode(false)}
                  className={`min-h-[40px] rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    !appendMode
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Starta ny runda
                </button>
              </div>
              <p className="text-xs text-slate-500">
                {appendMode
                  ? 'Likadana deliverynummer från flera klipp räknas ihop automatiskt.'
                  : 'Nuvarande lista sparas i historiken och ersätts av nästa filmning.'}
              </p>
            </div>

            <div>
              <label
                htmlFor="scanner-hint-input"
                className="block text-xs font-semibold text-slate-700"
              >
                Frivillig kontext / standardkund
              </label>
              <input
                id="scanner-hint-input"
                type="text"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                placeholder="T.ex. Microsoft Delivery (används om kund saknas på etikett)"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h3 className="text-xs font-semibold text-slate-800">
                Tips för 100 % träffsäkerhet
              </h3>
              <ul className="mt-2 space-y-1.5 text-xs text-slate-600">
                <li>1. Håll varje etikett skarp i 1–2 sekunder (eller tryck Fota 1 etikett).</li>
                <li>2. Se till att både kundnamn (t.ex. Microsoft) och Del/Rem-numret syns.</li>
                <li>3. Två separata kolli med samma nummer räknas ihop automatiskt till Antal 2.</li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
