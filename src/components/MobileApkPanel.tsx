import { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  Smartphone,
} from 'lucide-react';
import { isNativeCapacitorApp } from '../utils/apiConfig';
import { usePWAInstall } from '../hooks/usePWAInstall';

const WORKFLOW_YAML = `name: Build Android APK

on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build-apk:
    name: Build PaketScan APK
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm install --legacy-peer-deps --no-audit --no-fund

      - name: Build web bundle
        run: npm run build

      - name: Set up Java 21
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      - name: Set up Android SDK
        uses: android-actions/setup-android@v3

      - name: Sync Capacitor Android project
        run: npx cap sync android

      - name: Build Debug APK
        working-directory: android
        run: |
          chmod +x gradlew
          ./gradlew assembleDebug --no-daemon

      - name: Prepare APK artifact
        run: cp android/app/build/outputs/apk/debug/app-debug.apk PaketScan-debug.apk

      - name: Upload APK workflow artifact
        uses: actions/upload-artifact@v4
        with:
          name: PaketScan-debug-apk
          path: PaketScan-debug.apk

      - name: Publish downloadable GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: latest-apk
          name: PaketScan Android APK (Senaste)
          body: |
            Automatiskt byggd Android APK för PaketScan.
            Ladda ner PaketScan-debug.apk nedan på din Android-telefon och installera.
          files: PaketScan-debug.apk
          prerelease: false
          make_latest: true`;

export function MobileApkPanel() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [copiedYaml, setCopiedYaml] = useState(false);
  const [repoSlug, setRepoSlug] = useState('nRn-World/Scan2');
  const isNative = isNativeCapacitorApp();

  const cleanRepoSlug = useMemo(() => {
    const clean = repoSlug.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    return clean.includes('/') ? clean : 'nRn-World/Scan2';
  }, [repoSlug]);

  const githubNewWorkflowUrl = useMemo(() => {
    const params = new URLSearchParams({
      filename: '.github/workflows/build-apk.yml',
      value: WORKFLOW_YAML,
    });
    return `https://github.com/${cleanRepoSlug}/new/main?${params.toString()}`;
  }, [cleanRepoSlug]);

  const githubActionsUrl = `https://github.com/${cleanRepoSlug}/actions`;
  const githubReleasesUrl = `https://github.com/${cleanRepoSlug}/releases`;

  const handleCopyYaml = async () => {
    try {
      await navigator.clipboard.writeText(WORKFLOW_YAML);
      setCopiedYaml(true);
      window.setTimeout(() => setCopiedYaml(false), 2500);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <section
      aria-labelledby="mobile-apk-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
    >
      <h1
        id="mobile-apk-heading"
        className="font-display text-2xl font-bold tracking-tight text-slate-900"
      >
        Mobilapp &amp; Android APK via GitHub
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Testa appen direkt på telefonen nu, eller bygg och ladda ner en färdig Android{' '}
        <span className="font-mono text-xs">.apk</span>-fil automatiskt via GitHub.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Card 1: Instant Mobile PWA Test */}
        <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-600 text-white">
                <Smartphone className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900">
                  1. Testa direkt på mobilen (PWA)
                </h2>
                <p className="text-xs text-slate-600">
                  Kräver ingen APK-fil — installeras på hemskärmen direkt i Chrome eller Safari.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs text-slate-700">
              {isInstalled || isNative ? (
                <p className="flex items-center gap-2 font-medium text-emerald-700">
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Appen körs redan installerad på din enhet.</span>
                </p>
              ) : isIOS ? (
                <ol className="list-decimal space-y-1.5 pl-4">
                  <li>Öppna appens delade länk i Safari på iPhone/iPad.</li>
                  <li>Tryck på Dela-knappen i verktygsfältet.</li>
                  <li>Välj Lägg till på hemskärmen för att köra i helskärm.</li>
                </ol>
              ) : (
                <ol className="list-decimal space-y-1.5 pl-4">
                  <li>Öppna appen i Chrome på din Android-telefon.</li>
                  <li>
                    Tryck på <strong>Installera app</strong> (eller Chrome-menyn ⋮ →{' '}
                    <em>Installera app</em>).
                  </li>
                  <li>Öppna PaketScan från hemskärmen och filma paket med bakre kameran.</li>
                </ol>
              )}
            </div>
          </div>

          {isInstallable && !isInstalled && (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => void install()}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>Installera app på enheten</span>
              </button>
            </div>
          )}
        </div>

        {/* Card 2: GitHub Actions -> Android APK */}
        <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
                <GitBranch className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900">
                  2. Aktivera APK-bygge på GitHub (1 klick)
                </h2>
                <p className="text-xs text-slate-600">
                  Öppnar GitHub färdigifylld — du behöver bara trycka Commit changes.
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor="github-repo-input" className="block text-xs font-medium text-slate-700">
                GitHub-repository
              </label>
              <input
                id="github-repo-input"
                type="text"
                value={repoSlug}
                onChange={(e) => setRepoSlug(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <ol className="mt-3 list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-slate-700">
              <li>
                Pusha koden via <strong>GitHub sync</strong> i AI Studio.
              </li>
              <li>
                Klicka på <strong>Skapa byggfil på GitHub</strong> nedan och tryck{' '}
                <strong>Commit changes</strong>.
              </li>
              <li>
                Vänta ca 2–3 min under fliken <strong>Actions</strong> — sedan finns{' '}
                <span className="font-mono font-semibold text-slate-900">
                  PaketScan-debug.apk
                </span>{' '}
                under <strong>Releases</strong> och <strong>Artifacts</strong>.
              </li>
            </ol>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <a
                href={githubNewWorkflowUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                <span>Skapa byggfil på GitHub</span>
              </a>

              <button
                type="button"
                onClick={() => void handleCopyYaml()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-100"
              >
                {copiedYaml ? (
                  <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                <span>{copiedYaml ? 'Kopierad!' : 'Kopiera YAML'}</span>
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <a
                href={githubActionsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-sky-700 hover:text-sky-900 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Öppna GitHub Actions</span>
              </a>
              <span aria-hidden="true" className="text-slate-300">
                |
              </span>
              <a
                href={githubReleasesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-sky-700 hover:text-sky-900 hover:underline"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Öppna Releases (APK-nedladdning)</span>
              </a>
            </div>
          </div>

          <div className="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-600">
            <span>Android-paket-ID: </span>
            <span className="font-mono font-medium text-slate-900">se.paketscan.app</span>
            <span aria-hidden="true"> · </span>
            <span>Lokal streckkodsläsare &amp; offline-OCR är inbyggt (inget API krävs)</span>
          </div>
        </div>
      </div>
    </section>
  );
}
