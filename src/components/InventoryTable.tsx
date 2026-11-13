import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Minus,
  Plus,
  Search,
  Trash2,
  PackageCheck,
} from 'lucide-react';
import type {
  InventoryItem,
  PackageType,
  RawDetectedPackage,
} from '../utils/inventory';

export type TypeFilter = 'all' | 'Delivery' | 'Removal' | 'review';

interface InventoryTableProps {
  items: InventoryItem[];
  onUpdateItem: (id: string, patch: Partial<InventoryItem>) => void;
  onRemoveItem: (id: string) => void;
  onAddManual: (raw: RawDetectedPackage) => void;
  onClearAll: () => void;
  onLoadDemo: () => void;
}

export function InventoryTable({
  items,
  onUpdateItem,
  onRemoveItem,
  onAddManual,
  onClearAll,
  onLoadDemo,
}: InventoryTableProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [showAddForm, setShowAddForm] = useState(false);

  const [newCustomer, setNewCustomer] = useState('');
  const [newType, setNewType] = useState<PackageType>('Delivery');
  const [newRef, setNewRef] = useState('');
  const [newBarcode, setNewBarcode] = useState('');
  const [newQty, setNewQty] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'Delivery' && item.type !== 'Delivery') return false;
      if (filter === 'Removal' && item.type !== 'Removal') return false;
      if (filter === 'review' && !item.needsReview) return false;

      if (!q) return true;
      return (
        item.customer.toLowerCase().includes(q) ||
        item.categoryLabel.toLowerCase().includes(q) ||
        item.referenceNumber.toLowerCase().includes(q) ||
        item.barcode.toLowerCase().includes(q) ||
        item.notes.toLowerCase().includes(q)
      );
    });
  }, [items, filter, search]);

  const handleAddSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!newRef.trim() && !newBarcode.trim()) {
      setFormError('Ange minst ett delivery-/removalnummer eller en streckkod.');
      return;
    }
    setFormError(null);
    onAddManual({
      customer: newCustomer.trim() || 'Okänd kund',
      type: newType,
      referenceNumber: newRef.trim(),
      barcode: newBarcode.trim(),
      quantity: Math.max(1, Number(newQty) || 1),
      confidence: 'high',
    });
    setNewRef('');
    setNewBarcode('');
    setNewQty(1);
    setShowAddForm(false);
  };

  const reviewCount = items.filter((i) => i.needsReview).length;

  return (
    <section
      aria-labelledby="inventory-table-heading"
      className="rounded-xl border border-slate-200 bg-white"
    >
      {/* Header & Controls */}
      <div className="flex flex-col gap-4 border-b border-slate-200 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2
            id="inventory-table-heading"
            className="font-display text-lg font-semibold text-slate-900"
          >
            Kategoriserad inventeringslista
          </h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Redigera valfri cell direkt eller justera antal innan du laddar ner Excel-filen.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setShowAddForm((prev) => !prev);
              setFormError(null);
            }}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 whitespace-nowrap hover:bg-slate-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Lägg till paket</span>
          </button>

          {items.length > 0 && (
            <button
              type="button"
              onClick={onClearAll}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 whitespace-nowrap hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Rensa lista</span>
            </button>
          )}
        </div>
      </div>

      {/* Inline Manual Add Form */}
      {showAddForm && (
        <form
          onSubmit={handleAddSubmit}
          className="border-b border-slate-200 bg-slate-50 p-4 sm:p-5"
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div>
              <label htmlFor="manual-customer" className="block text-xs font-medium text-slate-700">
                Kund
              </label>
              <input
                id="manual-customer"
                type="text"
                value={newCustomer}
                onChange={(e) => setNewCustomer(e.target.value)}
                placeholder="t.ex. Microsoft"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="manual-type" className="block text-xs font-medium text-slate-700">
                Typ
              </label>
              <select
                id="manual-type"
                value={newType}
                onChange={(e) => setNewType(e.target.value as PackageType)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
              >
                <option value="Delivery">Delivery</option>
                <option value="Removal">Removal</option>
                <option value="Okänd">Okänd</option>
              </select>
            </div>

            <div className="lg:col-span-2">
              <label htmlFor="manual-ref" className="block text-xs font-medium text-slate-700">
                Delivery- / Removalnummer
              </label>
              <input
                id="manual-ref"
                type="text"
                value={newRef}
                onChange={(e) => setNewRef(e.target.value)}
                placeholder="t.ex. Del001234567"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="manual-barcode" className="block text-xs font-medium text-slate-700">
                Streckkod (valfri)
              </label>
              <input
                id="manual-barcode"
                type="text"
                value={newBarcode}
                onChange={(e) => setNewBarcode(e.target.value)}
                placeholder="t.ex. 7310012345678"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="manual-qty" className="block text-xs font-medium text-slate-700">
                Antal
              </label>
              <input
                id="manual-qty"
                type="number"
                min={1}
                value={newQty}
                onChange={(e) => setNewQty(Math.max(1, Number(e.target.value) || 1))}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>
          </div>

          {formError && (
            <p role="alert" className="mt-2 text-xs font-medium text-red-700">
              {formError}
            </p>
          )}

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="min-h-[40px] rounded-lg px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Avbryt
            </button>
            <button
              type="submit"
              className="min-h-[40px] rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-700"
            >
              Spara i lista
            </button>
          </div>
        </form>
      )}

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="relative flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Sök i inventeringslistan"
            placeholder="Sök kund, nummer eller streckkod..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:bg-white focus:outline-none"
          />
        </div>

        <div
          role="group"
          aria-label="Filtrera pakettyp"
          className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1"
        >
          {(
            [
              { id: 'all', label: 'Alla' },
              { id: 'Delivery', label: 'Delivery' },
              { id: 'Removal', label: 'Removal' },
              {
                id: 'review',
                label: reviewCount > 0 ? `Granska (${reviewCount})` : 'Granska',
              },
            ] as const
          ).map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                aria-pressed={active}
                className={`min-h-[36px] rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Empty State */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-500">
            <PackageCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <h3 className="mt-3 font-display text-base font-semibold text-slate-900">
            Inga paket inlästa ännu
          </h3>
          <p className="mt-1 max-w-md text-sm text-slate-600">
            Filma dina paket ovan eller ladda upp en video. Alla paket kategoriseras automatiskt
            efter kund, Delivery/Removal, nummer och antal.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={onLoadDemo}
              className="min-h-[44px] rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-700"
            >
              Ladda exempel-inventering
            </button>
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="min-h-[44px] rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50"
            >
              Lägg till rad manuellt
            </button>
          </div>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-slate-600">
          Inga paket matchar din sökning eller ditt filter.
        </div>
      ) : (
        <>
          {/* Desktop High-Density Spreadsheet Table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th scope="col" className="py-2.5 pr-3 pl-5">
                    Kund
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Typ
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Kategori
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Nummer
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Streckkod
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-center">
                    Antal
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Status
                  </th>
                  <th scope="col" className="py-2.5 pr-5 pl-3 text-right">
                    Åtgärd
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredItems.map((item) => (
                  <tr
                    key={item.id}
                    className={`transition-colors hover:bg-slate-50/80 ${
                      item.needsReview ? 'bg-amber-50/35' : ''
                    }`}
                  >
                    <td className="py-2 pr-3 pl-5">
                      <input
                        type="text"
                        aria-label={`Kund för ${item.referenceNumber}`}
                        value={item.customer}
                        onChange={(e) => onUpdateItem(item.id, { customer: e.target.value })}
                        className="w-32 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium text-slate-900 hover:border-slate-200 focus:border-sky-600 focus:bg-white focus:outline-none"
                      />
                    </td>

                    <td className="px-3 py-2">
                      <select
                        aria-label={`Pakettyp för ${item.referenceNumber}`}
                        value={item.type}
                        onChange={(e) =>
                          onUpdateItem(item.id, { type: e.target.value as PackageType })
                        }
                        className={`rounded border border-transparent bg-transparent px-1.5 py-1 text-xs font-semibold hover:border-slate-200 focus:border-sky-600 focus:bg-white focus:outline-none ${
                          item.type === 'Delivery'
                            ? 'text-emerald-700'
                            : item.type === 'Removal'
                              ? 'text-amber-700'
                              : 'text-slate-600'
                        }`}
                      >
                        <option value="Delivery">Delivery</option>
                        <option value="Removal">Removal</option>
                        <option value="Okänd">Okänd</option>
                      </select>
                    </td>

                    <td className="px-3 py-2 text-xs text-slate-700 whitespace-nowrap">
                      {item.categoryLabel}
                    </td>

                    <td className="px-3 py-2">
                      <input
                        type="text"
                        aria-label={`Deliverynummer för ${item.customer} ${item.referenceNumber}`}
                        value={item.referenceNumber}
                        onChange={(e) =>
                          onUpdateItem(item.id, { referenceNumber: e.target.value })
                        }
                        className="w-40 rounded border border-transparent bg-transparent px-1.5 py-1 font-mono text-xs font-medium tabular-nums text-slate-900 hover:border-slate-200 focus:border-sky-600 focus:bg-white focus:outline-none"
                      />
                      {item.needsReview && item.notes && (
                        <p className="px-1.5 text-[11px] text-amber-800 max-w-[14rem] truncate" title={item.notes}>
                          {item.notes}
                        </p>
                      )}
                    </td>

                    <td className="px-3 py-2">
                      <input
                        type="text"
                        aria-label={`Streckkod för ${item.referenceNumber}`}
                        value={item.barcode}
                        placeholder="-"
                        onChange={(e) => onUpdateItem(item.id, { barcode: e.target.value })}
                        className="w-36 rounded border border-transparent bg-transparent px-1.5 py-1 font-mono text-xs tabular-nums text-slate-600 hover:border-slate-200 focus:border-sky-600 focus:bg-white focus:outline-none"
                      />
                    </td>

                    <td className="px-3 py-2 text-center">
                      <div className="inline-flex items-center justify-center gap-1">
                        <button
                          type="button"
                          aria-label={`Minska antal för ${item.referenceNumber}`}
                          onClick={() =>
                            onUpdateItem(item.id, {
                              quantity: Math.max(1, item.quantity - 1),
                            })
                          }
                          disabled={item.quantity <= 1}
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                        >
                          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <span
                          data-testid={`qty-${item.referenceNumber}`}
                          className="w-8 text-center font-mono text-sm font-semibold tabular-nums text-slate-900"
                        >
                          {item.quantity}
                        </span>
                        <button
                          type="button"
                          aria-label={`Öka antal för ${item.referenceNumber}`}
                          onClick={() =>
                            onUpdateItem(item.id, { quantity: item.quantity + 1 })
                          }
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-600 hover:bg-slate-100"
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </td>

                    <td className="px-3 py-2 whitespace-nowrap">
                      {item.needsReview ? (
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateItem(item.id, {
                              confidence: 'high',
                              needsReview: false,
                            })
                          }
                          title={item.notes || 'Klicka för att markera som verifierad'}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-900"
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>Kontrollera</span>
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>Verifierad</span>
                        </span>
                      )}
                    </td>

                    <td className="py-2 pr-5 pl-3 text-right">
                      <button
                        type="button"
                        aria-label={`Ta bort ${item.referenceNumber}`}
                        onClick={() => onRemoveItem(item.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Touch-Friendly List */}
          <div className="divide-y divide-slate-200 md:hidden">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className={`p-4 ${item.needsReview ? 'bg-amber-50/40' : 'bg-white'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                      <span className="font-semibold text-slate-900">{item.customer}</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={`font-semibold ${
                          item.type === 'Delivery'
                            ? 'text-emerald-700'
                            : item.type === 'Removal'
                              ? 'text-amber-700'
                              : 'text-slate-600'
                        }`}
                      >
                        {item.type}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{item.categoryLabel}</span>
                    </div>
                    <p className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-900 break-all">
                      {item.referenceNumber}
                    </p>
                    {item.barcode && (
                      <p className="mt-0.5 font-mono text-xs tabular-nums text-slate-500">
                        Streckkod: {item.barcode}
                      </p>
                    )}
                    {item.notes && (
                      <p className="mt-1 text-xs text-amber-800">{item.notes}</p>
                    )}
                  </div>

                  <button
                    type="button"
                    aria-label={`Ta bort ${item.referenceNumber}`}
                    onClick={() => onRemoveItem(item.id)}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <div>
                    {item.needsReview ? (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateItem(item.id, {
                            confidence: 'high',
                            needsReview: false,
                          })
                        }
                        className="inline-flex min-h-[44px] items-center gap-1.5 text-xs font-medium text-amber-700"
                      >
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <span>Kontrollera (tryck för att godkänna)</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        <span>Verifierad</span>
                      </span>
                    )}
                  </div>

                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={`Minska antal för ${item.referenceNumber}`}
                      onClick={() =>
                        onUpdateItem(item.id, {
                          quantity: Math.max(1, item.quantity - 1),
                        })
                      }
                      disabled={item.quantity <= 1}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 disabled:opacity-40"
                    >
                      <Minus className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <span className="w-8 text-center font-mono text-sm font-semibold tabular-nums text-slate-900">
                      {item.quantity}
                    </span>
                    <button
                      type="button"
                      aria-label={`Öka antal för ${item.referenceNumber}`}
                      onClick={() =>
                        onUpdateItem(item.id, { quantity: item.quantity + 1 })
                      }
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
