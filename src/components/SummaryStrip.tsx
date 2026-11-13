import type { InventorySummary } from '../utils/inventory';

interface SummaryStripProps {
  summary: InventorySummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
  const stats = [
    {
      label: 'Totalt antal kolli',
      value: summary.totalPackages,
      sub: summary.totalPackages === 1 ? '1 paket räknat' : `${summary.totalPackages} paket räknade`,
      accent: 'text-slate-900',
    },
    {
      label: 'Unika nummer',
      value: summary.uniqueCount,
      sub:
        summary.reviewNeededCount > 0
          ? `${summary.reviewNeededCount} att kontrollera`
          : 'Alla rader verifierade',
      accent: 'text-slate-900',
    },
    {
      label: 'Delivery',
      value: summary.deliveryCount,
      sub: 'Inkommande / leverans',
      accent: 'text-emerald-700',
    },
    {
      label: 'Removal',
      value: summary.removalCount,
      sub: 'Utgående / retur',
      accent: 'text-amber-700',
    },
  ];

  return (
    <section aria-label="Sammanfattning av inventering" className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-slate-200 bg-white p-4"
          >
            <p className="text-xs font-medium text-slate-600">{stat.label}</p>
            <p
              data-testid={`stat-${stat.label}`}
              className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${stat.accent}`}
            >
              {stat.value}
            </p>
            <p className="mt-1 text-xs text-slate-500">{stat.sub}</p>
          </div>
        ))}
      </div>

      {summary.customerBreakdown.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
          <span className="font-semibold text-slate-900">Per kund:</span>
          {summary.customerBreakdown.map((group) => (
            <span key={group.customer} className="inline-flex items-center gap-1.5">
              <span className="font-medium text-slate-900">{group.customer}</span>
              <span className="tabular-nums">
                {group.deliveryCount > 0 ? `${group.deliveryCount} Delivery` : ''}
                {group.deliveryCount > 0 && group.removalCount > 0 ? ' · ' : ''}
                {group.removalCount > 0 ? `${group.removalCount} Removal` : ''}
                {group.unknownCount > 0
                  ? `${group.deliveryCount > 0 || group.removalCount > 0 ? ' · ' : ''}${group.unknownCount} Okänd`
                  : ''}
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
