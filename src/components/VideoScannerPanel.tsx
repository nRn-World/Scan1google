import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  FileVideo,
  Flashlight,
  Loader2,
  Play,
  Plus,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Square,
  Upload,
  Video,
  X,
  AlertCircle,
} from 'lucide-react';
import type { RawDetectedPackage, InventoryItem } from '../utils/inventory';
import {
  captureVideoElementFrame,
  createSampleShippingLabelFile,
  LiveCameraScannerSession,
  scanCapturedCameraFramesLocally,
  scanMediaFilesLocally,
  warmUpLocalScanner,
  type CapturedCameraFrame,
  type LiveScannedEntry,
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

function playConfirmationFeedback(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(60);
    }
  } catch {
    // Ignore vibration errors
  }

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1175, ctx.currentTime + 0.06);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.17);
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 250);
  } catch {
    // Ignore audio context restrictions
  }
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
  const [liveEntries, setLiveEntries] = useState<LiveScannedEntry[]>([]);
  const [liveMotionState, setLiveMotionState] = useState<'panning' | 'steady' | 'reading-ocr'>('steady');
  const [flashConfirmedLabel, setFlashConfirmedLabel] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sampleVariant, setSampleVariant] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveSessionRef = useRef<LiveCameraScannerSession | null>(null);
  const backupFramesRef = useRef<CapturedCameraFrame[]>([]);
  const recordingStartMsRef = useRef<number>(0);
  const liveLoopActiveRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const hintRef = useRef(hint);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    hintRef.current = hint;
  }, [hint]);

  const stopStream = () => {
    liveLoopActiveRef.current = false;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (flashTimerRef.current) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
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
    setTorchSupported(false);
    setTorchOn(false);
    setFlashConfirmedLabel(null);
  };

  useEffect(() => {
    return () => {
      stopStream();
    };
  }, []);

  const startCamera = async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErrorMsg(
        'Webbläsaren saknar direkt kamerastöd här (kräver HTTPS på mobil). Byt till "Ladda upp video/bild" eller testa på exempeletikett.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          const caps = videoTrack.getCapabilities?.() as
            | (MediaTrackCapabilities & { focusMode?: string[]; torch?: boolean })
            | undefined;
          if (caps?.torch) {
            setTorchSupported(true);
          }
          if (caps?.focusMode?.includes('continuous')) {
            await videoTrack.applyConstraints({
              advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
            });
          }
        } catch {
          // Ignore optional track constraint errors
        }
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      setLiveEntries([]);
      // Eagerly warm up WASM barcode reader + local Tesseract worker while user aims camera
      void warmUpLocalScanner();
    } catch {
      setErrorMsg(
        'Kunde inte starta kameran. Kontrollera kamerabehörighet (och att sidan körs på https://) eller ladda upp video/foton.'
      );
    }
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      // Ignore if device rejects torch toggle
    }
  };

  const triggerGreenFlash = (entry: LiveScannedEntry, totalCount: number) => {
    playConfirmationFeedback();
    const labelText = `✓ #${totalCount} läst: ${
      entry.pkg.customer && entry.pkg.customer !== 'Okänd kund' ? `${entry.pkg.customer} · ` : ''
    }${entry.pkg.referenceNumber || entry.pkg.barcode || 'Paket'}`;
    setFlashConfirmedLabel(labelText);
    if (flashTimerRef.current) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setFlashConfirmedLabel(null);
    }, 1500);
  };

  const startLiveRecordingScan = () => {
    if (!streamRef.current || !videoRef.current) return;
    setErrorMsg(null);
    backupFramesRef.current = [];
    const session = new LiveCameraScannerSession();
    liveSessionRef.current = session;
    setLiveEntries([]);
    setRecordingSeconds(0);
    recordingStartMsRef.current = Date.now();
    setRecording(true);
    liveLoopActiveRef.current = true;

    timerRef.current = window.setInterval(() => {
      setRecordingSeconds((prev) => prev + 1);
    }, 1000);

    const runLoop = async () => {
      while (liveLoopActiveRef.current && videoRef.current) {
        const elapsedSec = (Date.now() - recordingStartMsRef.current) / 1000;

        // Keep sparse sharp backup frames in case user sweeps very fast
        if (backupFramesRef.current.length < 24) {
          const lastBackup = backupFramesRef.current[backupFramesRef.current.length - 1];
          if (!lastBackup || elapsedSec - lastBackup.timestampSec >= 0.9) {
            const snap = captureVideoElementFrame(videoRef.current, elapsedSec, {
              widthRatio: 0.9,
              heightRatio: 0.78,
            });
            if (snap) backupFramesRef.current.push(snap);
          }
        }

        try {
          const tickResult = await session.processLiveVideoFrame(
            videoRef.current,
            elapsedSec,
            hintRef.current.trim() || undefined
          );
          if (!liveLoopActiveRef.current) break;

          setLiveMotionState(tickResult.motionState);
          if (tickResult.updated) {
            setLiveEntries(tickResult.entries);
          }
          if (tickResult.newlyLocked.length > 0) {
            const newest = tickResult.newlyLocked[tickResult.newlyLocked.length - 1];
            triggerGreenFlash(newest, tickResult.entries.length);
          }
        } catch {
          // Keep live loop resilient on transient frame errors
        }

        await new Promise((resolve) => window.setTimeout(resolve, 260));
      }
    };

    void runLoop();
  };

  const stopRecordingAndSave = async () => {
    liveLoopActiveRef.current = false;
    const session = liveSessionRef.current;

    // Capture one final crisp reticle frame right as user presses stop in case they were pointing at last label
    let finalFrame: CapturedCameraFrame | null = null;
    if (videoRef.current) {
      const elapsedSec = (Date.now() - recordingStartMsRef.current) / 1000;
      finalFrame = captureVideoElementFrame(videoRef.current, elapsedSec, {
        widthRatio: 0.9,
        heightRatio: 0.78,
      });
      if (session && videoRef.current) {
        try {
          await session.processLiveVideoFrame(
            videoRef.current,
            elapsedSec,
            hintRef.current.trim() || undefined
          );
        } catch {
          // Ignore
        }
      }
    }

    const backups = [...backupFramesRef.current];
    if (finalFrame) backups.push(finalFrame);
    backupFramesRef.current = [];
    stopStream();

    if (session && session.getEntries().length > 0) {
      const result = session.buildFinalScanResult();
      setLiveEntries([]);
      onScanComplete(result.items, 'camera', result.summaryNote);
      return;
    }

    // Fallback: if 0 labels locked in live (e.g. ultra-short clip), run deep pass on captured frames
    if (backups.length > 0) {
      setAnalyzing(true);
      setErrorMsg(null);
      setScanProgress({
        phase: 'scanning',
        percent: 20,
        message: 'Djupanalyserar inspelade etikettrutor...',
      });
      try {
        const deepResult = await scanCapturedCameraFramesLocally(backups, {
          hint: hint.trim() || undefined,
          onProgress: setScanProgress,
        });
        if (deepResult.items.length === 0) {
          setErrorMsg(
            'Inga tydliga etiketter kunde läsas av. Håll etiketten inom den markerade ramen tills den blinkar grönt innan du går till nästa paket.'
          );
          return;
        }
        onScanComplete(deepResult.items, 'camera', deepResult.summaryNote);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Ett fel uppstod vid kameraanalys.'
        );
      } finally {
        setAnalyzing(false);
        setScanProgress(null);
      }
    } else {
      setErrorMsg('Inga etikettrutor fångades. Håll kameran mot varje etikett tills rutan blinkar grönt.');
    }
  };

  const handleInstantSnapshotScan = async () => {
    if (!videoRef.current || !cameraActive) return;
    const snap = captureVideoElementFrame(videoRef.current, 0, {
      widthRatio: 0.9,
      heightRatio: 0.78,
    });
    if (!snap) {
      setErrorMsg('Kameran är inte redo ännu — vänta ett ögonblick och försök igen.');
      return;
    }
    stopStream();
    setAnalyzing(true);
    setErrorMsg(null);
    setScanProgress({
      phase: 'scanning',
      percent: 25,
      message: 'Beskär etikett och läser streckkod + text...',
    });

    try {
      const result = await scanCapturedCameraFramesLocally([snap], {
        hint: hint.trim() || undefined,
        onProgress: setScanProgress,
      });
      if (result.items.length === 0) {
        setErrorMsg(
          'Hittade ingen tydlig streckkod eller referenstext på etiketten. Håll närmare inom etikettramen i bra ljus.'
        );
        return;
      }
      onScanComplete(result.items, 'camera', result.summaryNote);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Kunde inte analysera etikettbilden.');
    } finally {
      setAnalyzing(false);
      setScanProgress(null);
    }
  };

  const handleRemoveLiveEntry = (uid: string) => {
    if (!liveSessionRef.current) return;
    setLiveEntries(liveSessionRef.current.removeEntry(uid));
  };

  const handleIncrementLiveEntry = (uid: string) => {
    if (!liveSessionRef.current) return;
    playConfirmationFeedback();
    setLiveEntries(liveSessionRef.current.incrementEntryQuantity(uid));
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
          'Inga tydliga deliverynummer eller streckkoder hittades i bilden/videon. Försök fota närmare själva etiketten.'
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
      message: 'Skapar etikett på kartongbakgrund, beskär och kör lokal OCR...',
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

  const totalLivePackages = liveEntries.reduce(
    (sum, e) => sum + Math.max(1, e.pkg.quantity ?? 1),
    0
  );

  return (
    <section
      aria-labelledby="scanner-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            <span>Live Etikettbeskärning + Lokal Streckkod &amp; OCR · Utan API</span>
          </div>
          <h1
            id="scanner-heading"
            className="mt-2 font-display text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl"
          >
            Filma paket till Excel
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Rikta kameran mot varje etikett — rutan blinkar grönt och piper direkt när paketet har
            lästs in, så du vet exakt när du kan gå till nästa låda.
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
            <span>Skanna live</span>
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
            <div className="relative flex min-h-[360px] sm:min-h-[430px] lg:h-full w-full flex-col items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950 text-white">
              <video
                ref={videoRef}
                playsInline
                muted
                className={`h-full w-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
              />

              {/* Guided Etikettram (Target Label Crop Frame) */}
              {cameraActive && !analyzing && (
                <div
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-x-[7%] top-[12%] bottom-[24%] rounded-xl border-2 transition-all duration-200 ${
                    flashConfirmedLabel
                      ? 'border-emerald-400 bg-emerald-500/15 shadow-[0_0_30px_rgba(52,211,153,0.45)]'
                      : recording
                        ? 'border-sky-400/85'
                        : 'border-white/45'
                  }`}
                >
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-slate-950/85 px-3 py-0.5 text-[11px] font-medium whitespace-nowrap text-slate-200">
                    {flashConfirmedLabel ? (
                      <span className="text-emerald-300 font-semibold">{flashConfirmedLabel}</span>
                    ) : recording ? (
                      liveMotionState === 'panning' ? (
                        'Håll kameran stilla över etiketten...'
                      ) : liveMotionState === 'reading-ocr' ? (
                        'Läser av etikett inom ramen...'
                      ) : (
                        'Placera hela fraktetiketten inom ramen'
                      )
                    ) : (
                      'Rikta ramen mot etiketten'
                    )}
                  </div>
                </div>
              )}

              {/* Top Bar: Live Recording Status + Torch Toggle */}
              {cameraActive && !analyzing && (
                <div className="absolute top-3 inset-x-3 flex items-center justify-between gap-2">
                  {recording ? (
                    <div className="flex items-center gap-2 rounded-md bg-slate-950/85 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse"
                      />
                      <span>LIVE-SKANNING</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {formatDuration(recordingSeconds)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-emerald-300">
                        {totalLivePackages} {totalLivePackages === 1 ? 'paket' : 'paket'} lästa
                      </span>
                    </div>
                  ) : (
                    <div />
                  )}

                  {torchSupported && (
                    <button
                      type="button"
                      onClick={() => void toggleTorch()}
                      aria-pressed={torchOn}
                      className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium backdrop-blur-sm ${
                        torchOn
                          ? 'bg-amber-400 text-slate-950'
                          : 'border border-white/20 bg-slate-950/80 text-white'
                      }`}
                    >
                      <Flashlight className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{torchOn ? 'Lampa på' : 'Lampa'}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Live Scanned Chips Tray (shows every confirmed package right in camera!) */}
              {cameraActive && liveEntries.length > 0 && !analyzing && (
                <div
                  aria-live="polite"
                  className="absolute inset-x-3 bottom-[74px] max-h-28 overflow-y-auto rounded-lg border border-emerald-500/40 bg-slate-950/90 p-2 backdrop-blur-md"
                >
                  <div className="flex flex-col gap-1.5">
                    {liveEntries
                      .slice()
                      .reverse()
                      .map((entry, revIdx) => {
                        const num = liveEntries.length - revIdx;
                        const qty = Math.max(1, entry.pkg.quantity ?? 1);
                        return (
                          <div
                            key={entry.uid}
                            className="flex items-center justify-between gap-2 rounded bg-slate-900/90 px-2.5 py-1 text-xs"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <CheckCircle2
                                className="h-3.5 w-3.5 shrink-0 text-emerald-400"
                                aria-hidden="true"
                              />
                              <span className="font-mono text-[11px] text-slate-400">
                                #{num}
                              </span>
                              <span className="truncate font-semibold text-white">
                                {entry.pkg.customer || 'Okänd kund'}
                              </span>
                              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                                {entry.pkg.type || 'Okänd'}
                              </span>
                              <span className="truncate font-mono text-emerald-300">
                                {entry.pkg.referenceNumber || entry.pkg.barcode}
                              </span>
                              {qty > 1 && (
                                <span className="rounded bg-emerald-600/30 px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-200">
                                  ×{qty}
                                </span>
                              )}
                            </div>

                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleIncrementLiveEntry(entry.uid)}
                                title="Lägg till 1 till likadant kolli"
                                className="inline-flex h-6 items-center gap-0.5 rounded border border-slate-700 bg-slate-800 px-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
                              >
                                <Plus className="h-3 w-3" aria-hidden="true" />
                                <span>1</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemoveLiveEntry(entry.uid)}
                                aria-label="Ta bort avläsning"
                                className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-red-950 hover:text-red-300"
                              >
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Idle Placeholder State */}
              {!cameraActive && !analyzing && (
                <div className="flex flex-col items-center px-6 py-8 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-800 text-sky-400">
                    <Video className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <h2 className="mt-4 font-display text-lg font-semibold text-white">
                    Live-skanna paket &amp; etiketter med direktbekräftelse
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-slate-300">
                    Kameran beskär automatiskt in själva fraktetiketten, läser streckkod + text och
                    visar varje avläst paket direkt på skärmen medan du skannar.
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
                    {scanProgress?.message || 'Beskär etikett och läser av streckkoder...'}
                  </p>
                  <p className="mt-1 max-w-sm text-xs text-slate-300">
                    Körs 100 % lokalt på din enhet (ZXing WASM + Tesseract OCR).
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
                <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-2 bg-gradient-to-t from-black/90 via-black/70 to-transparent p-3.5">
                  <button
                    type="button"
                    onClick={stopStream}
                    className="inline-flex min-h-[44px] items-center rounded-lg border border-white/20 bg-slate-900/85 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    Stäng
                  </button>

                  {!recording ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleInstantSnapshotScan()}
                        className="inline-flex min-h-[46px] items-center gap-1.5 rounded-lg border border-white/25 bg-slate-900/85 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        <ScanLine className="h-4 w-4 text-sky-400" aria-hidden="true" />
                        <span>Fota 1 etikett</span>
                      </button>
                      <button
                        type="button"
                        onClick={startLiveRecordingScan}
                        className="inline-flex min-h-[46px] items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-500"
                      >
                        <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                        <span>Starta live-skanning</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void stopRecordingAndSave()}
                      className="inline-flex min-h-[46px] items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                      <span>
                        {totalLivePackages > 0
                          ? `Klar — spara ${totalLivePackages} paket`
                          : 'Avsluta & analysera'}
                      </span>
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
              className={`relative flex min-h-[320px] sm:min-h-[390px] lg:h-full w-full flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
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
                    {scanProgress?.message || 'Beskär etiketter & analyserar lokalt...'}
                  </p>
                  <p className="mt-1 max-w-sm text-xs text-slate-600">
                    Isolerar fraktetiketter från bakgrunden och läser streckkoder + text direkt på enheten.
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
                    Släpp video eller skarpa etikettfoton här
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-slate-600">
                    Stöder flera foton samtidigt (t.ex. 3 foton på 3 etiketter) samt MP4/MOV/WebM-video.
                    Etiketten beskärs ut automatiskt före avläsning.
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
                      <span>Välj foton / video</span>
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
                Styr hur nya skanningar slås ihop med din nuvarande Excel-lista.
              </p>
            </div>

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-950">
              <p className="font-semibold text-emerald-900">
                Smart etikettbeskärning &amp; live-låsning
              </p>
              <p className="mt-1 text-emerald-800 leading-relaxed">
                Kameran isolerar den vita etiketten i full upplösning, skärper texten och ger{' '}
                <strong>grön blinkning + pip</strong> för varje avläst paket innan du flyttar
                mobilen till nästa låda.
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
                  ? 'Likadana nummer räknas ihop automatiskt i nuvarande lista.'
                  : 'Nuvarande lista sparas i historiken och ersätts av nästa skanning.'}
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
                placeholder="T.ex. Microsoft Delivery (om kund saknas på etikett)"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h3 className="text-xs font-semibold text-slate-800">
                Så skannar du 3+ etiketter i rad på mobilen
              </h3>
              <ul className="mt-2 space-y-1.5 text-xs text-slate-600">
                <li>1. Håll etikett 1 inom ramen (ca 15–25 cm avstånd) tills ramen blinkar grönt.</li>
                <li>2. Flytta sedan till etikett 2 och 3 — varje paket dyker upp live nederst i kameran.</li>
                <li>3. Tryck <strong>Klar — spara X paket</strong> så hamnar alla direkt i Excel!</li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
