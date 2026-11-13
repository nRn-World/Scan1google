import { Download } from 'lucide-react';

export type ActiveTab = 'scanner' | 'inventory' | 'notepad' | 'history';

interface HeaderBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  totalPackages: number;
  onExportExcel: () => void;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'scanner', label: 'Skanna' },
  { id: 'inventory', label: 'Lista' },
  { id: 'notepad', label: 'Anteckningar' },
  { id: 'history', label: 'Historik' },
];

export function HeaderBar({
  activeTab,
  onSelectTab,
  totalPackages,
  onExportExcel,
}: HeaderBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('scanner')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
        >
          PaketScan
        </button>

        {/* Zone 2: Clean single-line navigation links */}
        <nav aria-label="Huvudmeny" className="hidden md:flex items-center gap-6">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            const showCount = item.id === 'inventory' && totalPackages > 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative py-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${
                  isActive
                    ? 'text-slate-900'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>
                  {item.label}
                  {showCount ? ` (${totalPackages})` : ''}
                </span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-sky-600"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onExportExcel}
            disabled={totalPackages === 0}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Exportera Excel</span>
          </button>
        </div>
      </div>

      {/* Mobile navigation strip (compact, under 15% sticky height cap combined) */}
      <nav
        aria-label="Mobilmeny"
        className="grid grid-cols-4 border-t border-slate-100 bg-white md:hidden"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`min-h-[44px] px-2 py-2 text-xs font-medium whitespace-nowrap truncate transition-colors ${
                isActive
                  ? 'border-b-2 border-sky-600 text-sky-700 bg-sky-50/40'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
              {item.id === 'inventory' && totalPackages > 0 ? ` (${totalPackages})` : ''}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
