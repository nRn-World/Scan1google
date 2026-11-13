import { useMemo, useState } from 'react';
import { Check, Copy, Download, FileSpreadsheet, FileText, Share2 } from 'lucide-react';
import { formatInventoryAsNotepadText, type InventoryItem } from '../utils/inventory';
import { createExcelFileName, getInventoryExcelBuffer } from '../utils/excelExport';

interface NotepadExportPanelProps {
  items: InventoryItem[];
  sessionTitle: string;
  onDownloadExcel: () => void;
}

export function NotepadExportPanel({
  items,
  sessionTitle,
  onDownloadExcel,
}: NotepadExportPanelProps) {
  const [copied, setCopied] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

  const notepadText = useMemo(
    () => formatInventoryAsNotepadText(items, sessionTitle),
    [items, sessionTitle]
  );

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(notepadText);
      setCopied(true);
      setShareFeedback('Textlistan är kopierad till urklipp.');
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setShareFeedback('Kunde inte kopiera automatiskt — markera texten och tryck Ctrl+C.');
    }
  };

  const handleDownloadTxt = () => {
    // Include UTF-8 BOM (\uFEFF) so Swedish åäö renders properly in Windows Anteckningar / Notepad
    const blob = new Blob(['\uFEFF' + notepadText], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `inventering-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setShareFeedback('Anteckningsfil (.txt) nedladdad.');
  };

  const handleShare = async () => {
    if (items.length === 0) return;

    try {
      const buffer = getInventoryExcelBuffer(items, sessionTitle);
      const fileName = createExcelFileName('paketinventering');
      const excelFile = new File([buffer.buffer as ArrayBuffer], fileName, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      if (
        typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [excelFile] })
      ) {
        await navigator.share({
          title: sessionTitle,
          text: notepadText,
          files: [excelFile],
        });
        setShareFeedback('Delning slutförd.');
        return;
      }

      if (typeof navigator.share === 'function') {
        await navigator.share({
          title: sessionTitle,
          text: notepadText,
        });
        setShareFeedback('Textlista delad.');
        return;
      }

      // Desktop browser fallback: download Excel + copy text
      onDownloadExcel();
      await navigator.clipboard.writeText(notepadText).catch(() => {});
      setShareFeedback(
        'Excel-fil nedladdad och text kopierad till urklipp (klar att klistra in eller mejla).'
      );
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setShareFeedback('Delning avbröts. Använd knapparna för att ladda ner Excel eller text.');
      }
    }
  };

  return (
    <section
      aria-labelledby="notepad-export-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="notepad-export-heading"
            className="font-display text-lg font-semibold text-slate-900"
          >
            Anteckningsblock &amp; Export
          </h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Färdigstrukturerad text och Excel-fil att ta med till datorn för snabb registrering.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onDownloadExcel}
            disabled={items.length === 0}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
          >
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            <span>Ladda ner Excel (.xlsx)</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadTxt}
            disabled={items.length === 0}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 whitespace-nowrap hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            <span>Ladda ner .txt</span>
          </button>

          <button
            type="button"
            onClick={handleCopyText}
            disabled={items.length === 0}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 whitespace-nowrap hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{copied ? 'Kopierad' : 'Kopiera text'}</span>
          </button>

          <button
            type="button"
            onClick={handleShare}
            disabled={items.length === 0}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 whitespace-nowrap hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Share2 className="h-4 w-4" aria-hidden="true" />
            <span>Dela</span>
          </button>
        </div>
      </div>

      {shareFeedback && (
        <p
          role="status"
          aria-live="polite"
          className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2 text-xs font-medium text-sky-900"
        >
          {shareFeedback}
        </p>
      )}

      <div className="mt-4">
        <label htmlFor="notepad-preview-area" className="sr-only">
          Förhandsvisning av anteckningsblock
        </label>
        <textarea
          id="notepad-preview-area"
          readOnly
          value={notepadText}
          rows={12}
          className="w-full rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 focus:border-sky-600 focus:outline-none sm:text-sm"
        />
      </div>

      {items.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            Innehåller både grupperad läslista och tab-separerad radlista för direkt inklistring.
          </span>
          <button
            type="button"
            onClick={onDownloadExcel}
            className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Öppna i Excel</span>
          </button>
        </div>
      )}
    </section>
  );
}
