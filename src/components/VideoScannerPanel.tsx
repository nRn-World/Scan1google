import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  FileVideo,
  Loader2,
  Play,
  Sparkles,
  Square,
  Upload,
  Video,
  AlertCircle,
} from 'lucide-react';
import { getApiEndpoint } from '../utils/apiConfig';
import type { RawDetectedPackage, InventoryItem } from '../utils/inventory';

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
  const [analyzing, setAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [recordedPreviewUrl, setRecordedPreviewUrl] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopStream = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
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
        'Webbläsaren saknar direkt kamerastöd här. Byt till fliken "Ladda upp video" eller testa med exempel-inventering.'
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
        'Kunde inte starta kameran. Kontrollera kamerabehörighet i webbläsaren eller ladda upp en inspelad video.'
      );
    }
  };

  const uploadAndAnalyze = async (filesToSend: File[], source: 'camera' | 'upload') => {
    setAnalyzing(true);
    setErrorMsg(null);

    try {
      const formData = new FormData();
      for (const file of filesToSend) {
        formData.append('media', file);
      }
      if (hint.trim()) {
        formData.append('hint', hint.trim());
      }

      const response = await fetch(getApiEndpoint('/api/scan-media'), {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as {
        items?: InventoryItem[];
        summaryNote?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || 'Kunde inte analysera videon.');
      }

      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) {
        setErrorMsg(
          'Inga tydliga deliverynummer eller streckkoder hittades i videon. Försök filma närmare etiketten i bättre ljus.'
        );
        return;
      }

      onScanComplete(items, source, payload.summaryNote || '');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Ett fel uppstod vid avläsning av videon.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    setErrorMsg(null);
    chunksRef.current = [];
    setRecordingSeconds(0);

    const candidateTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    const supportedType = candidateTypes.find((type) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)
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
        const mime = recorder.mimeType || 'video/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        stopStream();

        if (blob.size === 0) {
          setErrorMsg('Inspelningen blev tom. Försök filma minst 2–3 sekunder.');
          return;
        }

        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const videoFile = new File([blob], `inventering-${Date.now()}.${ext}`, {
          type: mime,
        });

        if (recordedPreviewUrl) {
          URL.revokeObjectURL(recordedPreviewUrl);
        }
        setRecordedPreviewUrl(URL.createObjectURL(blob));
        void uploadAndAnalyze([videoFile], 'camera');
      };

      mediaRecorderRef.current = recorder;
      recorder.start(500);
      setRecording(true);

      timerRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch {
      setErrorMsg('Kunde inte starta videoinspelning i denna webbläsare.');
    }
  };

  const stopRecordingAndProcess = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg(null);
    const validFiles = Array.from(fileList).filter(
      (f) => f.type.startsWith('video/') || f.type.startsWith('image/')
    );
    if (validFiles.length === 0) {
      setErrorMsg('Välj minst en video (MP4, MOV, WebM) eller bildfil (JPG, PNG).');
      return;
    }
    setSelectedFiles(validFiles);
  };

  const handleUploadSubmit = () => {
    if (selectedFiles.length === 0) {
      setErrorMsg('Välj en video eller etikettbild först.');
      return;
    }
    void uploadAndAnalyze(selectedFiles, 'upload');
  };

  return (
    <section
      aria-labelledby="scanner-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1
            id="scanner-heading"
            className="font-display text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl"
          >
            Filma paket till Excel
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Filma alla delivery- och removalpaket i ett svep. När du avslutar videon läses
            kund, typ, nummer och antal av automatiskt.
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
            <span>Ladda upp video</span>
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

              {/* Live Recording Telemetry (only rendered during real active recording) */}
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
                </div>
              )}

              {/* Idle Placeholder State */}
              {!cameraActive && !analyzing && (
                <div className="flex flex-col items-center px-6 py-8 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-800 text-sky-400">
                    <Video className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <h2 className="mt-4 font-display text-lg font-semibold text-white">
                    Redo att filma paket &amp; streckkoder
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-slate-300">
                    Starta kameran och svep lugnt över varje fraktetikett. När du stänger videon
                    sorteras allt direkt i Excel.
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
                      onClick={() => onLoadDemo()}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                    >
                      <Sparkles className="h-4 w-4 text-sky-400" aria-hidden="true" />
                      <span>Ladda exempel-inventering</span>
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
                    Läser av streckkoder och deliverynummer...
                  </p>
                  <p className="mt-1 max-w-sm text-sm text-slate-300">
                    Kontrollerar kundnamn, skiljer på Delivery och Removal samt slår ihop dubbletter.
                  </p>
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
                    <button
                      type="button"
                      onClick={startRecording}
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-lg bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-500"
                    >
                      <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                      <span>Starta filmning</span>
                    </button>
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
                    Analyserar uppladdat material...
                  </p>
                  <p className="mt-1 max-w-sm text-sm text-slate-600">
                    Extraherar kund, Delivery/Removal-typ och exakta siffror.
                  </p>
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
                    Stöder MP4, MOV, WebM upp till 95 MB samt JPG/PNG-bilder av fraktetiketter.
                  </p>

                  {selectedFiles.length > 0 && (
                    <div className="mt-4 w-full max-w-md rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-left text-xs text-slate-700">
                      <p className="font-semibold text-slate-900">
                        Valda filer ({selectedFiles.length} st):
                      </p>
                      <ul className="mt-1 space-y-0.5 truncate font-mono">
                        {selectedFiles.slice(0, 4).map((file) => (
                          <li key={file.name + file.size} className="truncate">
                            {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
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

                    {selectedFiles.length > 0 && (
                      <button
                        type="button"
                        onClick={handleUploadSubmit}
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700"
                      >
                        <span>Analysera &amp; skapa lista</span>
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
                Styr hur nya filmningar slås ihop med din nuvarande Excel-lista.
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
                Frivillig kontext till avläsaren
              </label>
              <input
                id="scanner-hint-input"
                type="text"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                placeholder="T.ex. Endast Microsoft Delivery eller pall 2"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h3 className="text-xs font-semibold text-slate-800">
                Tips för 100 % träffsäkerhet
              </h3>
              <ul className="mt-2 space-y-1.5 text-xs text-slate-600">
                <li>1. Håll varje etikett skarp i 1–2 sekunder innan du går till nästa.</li>
                <li>2. Se till att både kundnamn (t.ex. Microsoft) och numret syns i bild.</li>
                <li>3. Två paket med samma nummer räknas ihop automatiskt till Antal 2.</li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
