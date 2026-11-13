import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, WifiOff } from 'lucide-react';
import { HeaderBar, type ActiveTab } from './components/HeaderBar';
import { VideoScannerPanel } from './components/VideoScannerPanel';
import { SummaryStrip } from './components/SummaryStrip';
import { InventoryTable } from './components/InventoryTable';
import { NotepadExportPanel } from './components/NotepadExportPanel';
import { SessionHistoryPanel } from './components/SessionHistoryPanel';
import { MobileApkPanel } from './components/MobileApkPanel';
import { useOnlineStatus, usePWAInstall } from './hooks/usePWAInstall';
import {
  calculateInventorySummary,
  DEMO_RAW_PACKAGES,
  mergeInventoryItems,
  recalculateItemMetadata,
  type InventoryItem,
  type RawDetectedPackage,
  type ScanSession,
} from './utils/inventory';
import { downloadInventoryExcel } from './utils/excelExport';

const STORAGE_SESSIONS_KEY = 'paketscan_sessions_v1';
const STORAGE_ACTIVE_ID_KEY = 'paketscan_active_session_v1';

function createBlankSession(index = 1): ScanSession {
  return {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: `Inventering ${new Date().toLocaleDateString('sv-SE')} #${index}`,
    createdAt: new Date().toISOString(),
    source: 'manual',
    items: [],
  };
}

function loadInitialSessions(): { sessions: ScanSession[]; activeId: string } {
  try {
    const rawSessions = localStorage.getItem(STORAGE_SESSIONS_KEY);
    const savedActiveId = localStorage.getItem(STORAGE_ACTIVE_ID_KEY);
    if (rawSessions) {
      const parsed = JSON.parse(rawSessions) as ScanSession[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const activeExists = parsed.some((s) => s.id === savedActiveId);
        return {
          sessions: parsed,
          activeId: activeExists && savedActiveId ? savedActiveId : parsed[0].id,
        };
      }
    }
  } catch {
    // Ignore storage corruption and create fresh session
  }

  const initial = createBlankSession(1);
  return { sessions: [initial], activeId: initial.id };
}

export default function App() {
  const initial = useMemo(() => loadInitialSessions(), []);
  const [sessions, setSessions] = useState<ScanSession[]>(initial.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string>(initial.activeId);
  const [activeTab, setActiveTab] = useState<ActiveTab>('scanner');
  const [appendMode, setAppendMode] = useState(true);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);
  const isOnline = useOnlineStatus();
  const { isInstallable, isInstalled, install } = usePWAInstall();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SESSIONS_KEY, JSON.stringify(sessions));
      localStorage.setItem(STORAGE_ACTIVE_ID_KEY, activeSessionId);
    } catch {
      // Ignore storage quota errors
    }
  }, [sessions, activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId]
  );

  const items = activeSession?.items ?? [];
  const summary = useMemo(() => calculateInventorySummary(items), [items]);

  const showNotice = (msg: string) => {
    setBannerNotice(msg);
  };

  const updateActiveSession = (updater: (session: ScanSession) => ScanSession) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSession.id ? updater(s) : s))
    );
  };

  const handleScanComplete = (
    scannedItems: InventoryItem[],
    source: 'camera' | 'upload',
    summaryNote: string
  ) => {
    const incomingRaw: RawDetectedPackage[] = scannedItems.map((item) => ({
      customer: item.customer,
      type: item.type,
      referenceNumber: item.referenceNumber,
      barcode: item.barcode,
      quantity: item.quantity,
      confidence: item.confidence,
      timestamp: item.timestamps[0],
      notes: item.notes,
    }));

    if (appendMode || items.length === 0) {
      updateActiveSession((session) => ({
        ...session,
        source,
        summaryNote,
        items: mergeInventoryItems(session.items, incomingRaw),
      }));
    } else {
      const nextSession: ScanSession = {
        ...createBlankSession(sessions.length + 1),
        source,
        summaryNote,
        items: mergeInventoryItems([], incomingRaw),
      };
      setSessions((prev) => [nextSession, ...prev]);
      setActiveSessionId(nextSession.id);
    }

    const totalAdded = scannedItems.reduce((sum, i) => sum + i.quantity, 0);
    showNotice(
      `Avläsning klar: ${totalAdded} kolli (${scannedItems.length} unika nummer) tillagda och kategoriserade.${
        summaryNote ? ` ${summaryNote}` : ''
      }`
    );
  };

  const handleLoadDemo = (customRaw?: RawDetectedPackage[]) => {
    const raw = customRaw ?? DEMO_RAW_PACKAGES;
    const merged = mergeInventoryItems(appendMode ? items : [], raw);
    updateActiveSession((session) => ({
      ...session,
      source: 'demo',
      items: merged,
    }));
    const demoSummary = calculateInventorySummary(merged);
    showNotice(
      `Exempel-inventering inläst: ${demoSummary.totalPackages} kolli (${demoSummary.uniqueCount} unika nummer), inklusive Microsoft Del001234567 med antal 2.`
    );
  };

  const handleUpdateItem = (id: string, patch: Partial<InventoryItem>) => {
    updateActiveSession((session) => ({
      ...session,
      items: session.items.map((item) =>
        item.id === id ? recalculateItemMetadata({ ...item, ...patch }) : item
      ),
    }));
  };

  const handleRemoveItem = (id: string) => {
    updateActiveSession((session) => ({
      ...session,
      items: session.items.filter((item) => item.id !== id),
    }));
  };

  const handleAddManual = (raw: RawDetectedPackage) => {
    updateActiveSession((session) => ({
      ...session,
      items: mergeInventoryItems(session.items, [raw]),
    }));
    showNotice('Paket tillagt och sammanslaget i listan.');
  };

  const handleClearAll = () => {
    updateActiveSession((session) => ({
      ...session,
      items: [],
      summaryNote: '',
    }));
    setBannerNotice('Nuvarande lista rensades.');
  };

  const handleExportExcel = () => {
    if (items.length === 0) return;
    const fileName = downloadInventoryExcel(items, activeSession.title);
    showNotice(`Excel-filen "${fileName}" har laddats ner och är klar för registrering.`);
  };

  const handleCreateNewSession = () => {
    const fresh = createBlankSession(sessions.length + 1);
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setActiveTab('scanner');
    showNotice(`Ny runda "${fresh.title}" skapad.`);
  };

  const handleDeleteSession = (sessionId: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      if (remaining.length === 0) {
        const fresh = createBlankSession(1);
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (activeSessionId === sessionId) {
        setActiveSessionId(remaining[0].id);
      }
      return remaining;
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <HeaderBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        totalPackages={summary.totalPackages}
        onExportExcel={handleExportExcel}
      />

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {/* Active Session Title & Status Banner */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <label htmlFor="session-title-input" className="sr-only">
              Namn på inventeringsrunda
            </label>
            <input
              id="session-title-input"
              type="text"
              value={activeSession?.title ?? ''}
              onChange={(e) =>
                updateActiveSession((s) => ({ ...s, title: e.target.value }))
              }
              className="rounded-lg border border-transparent bg-transparent px-2 py-1 font-display text-sm font-semibold text-slate-700 hover:border-slate-300 focus:border-sky-600 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isInstallable && !isInstalled && (
              <button
                type="button"
                onClick={() => void install()}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Installera på mobilen</span>
              </button>
            )}

            {bannerNotice && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs font-medium text-emerald-900"
              >
                <span className="inline-flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                  <span>{bannerNotice}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setBannerNotice(null)}
                  aria-label="Stäng meddelande"
                  className="text-emerald-700 hover:text-emerald-950"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        </div>

        {!isOnline && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-900"
          >
            <WifiOff className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
            <span>
              Offlineläge aktivt — lokal streckkodsläsare, OCR och dina sparade Excel-listor
              fungerar helt utan internet.
            </span>
          </div>
        )}

        {/* Scanner Tab or Combined Overview */}
        {activeTab === 'scanner' && (
          <>
            <VideoScannerPanel
              appendMode={appendMode}
              onToggleAppendMode={setAppendMode}
              onScanComplete={handleScanComplete}
              onLoadDemo={handleLoadDemo}
            />
            <SummaryStrip summary={summary} />
            <InventoryTable
              items={items}
              onUpdateItem={handleUpdateItem}
              onRemoveItem={handleRemoveItem}
              onAddManual={handleAddManual}
              onClearAll={handleClearAll}
              onLoadDemo={() => handleLoadDemo()}
            />
            <NotepadExportPanel
              items={items}
              sessionTitle={activeSession.title}
              onDownloadExcel={handleExportExcel}
            />
          </>
        )}

        {activeTab === 'inventory' && (
          <>
            <SummaryStrip summary={summary} />
            <InventoryTable
              items={items}
              onUpdateItem={handleUpdateItem}
              onRemoveItem={handleRemoveItem}
              onAddManual={handleAddManual}
              onClearAll={handleClearAll}
              onLoadDemo={() => handleLoadDemo()}
            />
          </>
        )}

        {activeTab === 'notepad' && (
          <>
            <SummaryStrip summary={summary} />
            <NotepadExportPanel
              items={items}
              sessionTitle={activeSession.title}
              onDownloadExcel={handleExportExcel}
            />
          </>
        )}

        {activeTab === 'history' && (
          <SessionHistoryPanel
            sessions={sessions}
            activeSessionId={activeSession.id}
            onSelectSession={(id) => {
              setActiveSessionId(id);
              setActiveTab('inventory');
            }}
            onCreateNewSession={handleCreateNewSession}
            onDeleteSession={handleDeleteSession}
          />
        )}

        {activeTab === 'apk' && <MobileApkPanel />}
      </main>
    </div>
  );
}
