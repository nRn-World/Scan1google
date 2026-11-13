import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { calculateInventorySummary, type ScanSession } from '../utils/inventory';

interface SessionHistoryPanelProps {
  sessions: ScanSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onCreateNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
}

export function SessionHistoryPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateNewSession,
  onDeleteSession,
}: SessionHistoryPanelProps) {
  return (
    <section
      aria-labelledby="history-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="history-heading" className="font-display text-lg font-semibold text-slate-900">
            Sparade inventeringsrundor
          </h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Alla filmade rundor sparas lokalt i webbläsaren så att du enkelt kan öppna och
            exportera senare vid datorn.
          </p>
        </div>

        <button
          type="button"
          onClick={onCreateNewSession}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap hover:bg-sky-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Ny inventeringsrunda</span>
        </button>
      </div>

      <div className="mt-4 divide-y divide-slate-100">
        {sessions.map((session) => {
          const summary = calculateInventorySummary(session.items);
          const isCurrent = session.id === activeSessionId;
          const dateFormatted = new Date(session.createdAt).toLocaleString('sv-SE', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <div
              key={session.id}
              className={`flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between ${
                isCurrent ? 'bg-sky-50/40 -mx-2 px-2 rounded-lg' : ''
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-semibold text-slate-900 truncate">
                    {session.title}
                  </span>
                  {isCurrent && (
                    <span className="text-xs font-semibold text-sky-700">· Aktiv runda</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span className="tabular-nums">{dateFormatted}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums font-medium text-slate-800">
                    {summary.totalPackages} kolli ({summary.uniqueCount} unika)
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">Delivery {summary.deliveryCount}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">Removal {summary.removalCount}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!isCurrent && (
                  <button
                    type="button"
                    onClick={() => onSelectSession(session.id)}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Öppna</span>
                  </button>
                )}
                {sessions.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Ta bort runda ${session.title}`}
                    onClick={() => onDeleteSession(session.id)}
                    className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
