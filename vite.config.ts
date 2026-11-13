import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const rootDir = import.meta.dirname;

const LOCAL_SCANNER_ASSETS: Record<string, { file: string; contentType: string }> = {
  'worker.min.js': {
    file: path.resolve(rootDir, 'node_modules/tesseract.js/dist/worker.min.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  'tesseract-core-simd-lstm.wasm.js': {
    file: path.resolve(rootDir, 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  'tesseract-core-lstm.wasm.js': {
    file: path.resolve(rootDir, 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  'eng.traineddata.gz': {
    file: path.resolve(
      rootDir,
      'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'
    ),
    contentType: 'application/octet-stream',
  },
  'swe.traineddata.gz': {
    file: path.resolve(
      rootDir,
      'node_modules/@tesseract.js-data/swe/4.0.0_best_int/swe.traineddata.gz'
    ),
    contentType: 'application/octet-stream',
  },
  'zxing_reader.wasm': {
    file: path.resolve(rootDir, 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm'),
    contentType: 'application/wasm',
  },
  'zxing_writer.wasm': {
    file: path.resolve(rootDir, 'node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'),
    contentType: 'application/wasm',
  },
};

function localScannerAssetsPlugin(): Plugin {
  return {
    name: 'local-scanner-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url?.split('?')[0] ?? '';
        const prefix = '/ocr-assets/';
        if (!rawUrl.startsWith(prefix)) {
          next();
          return;
        }

        const assetName = decodeURIComponent(rawUrl.slice(prefix.length));
        const asset = LOCAL_SCANNER_ASSETS[assetName];
        if (!asset || !fs.existsSync(asset.file)) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const stat = fs.statSync(asset.file);
        res.statusCode = 200;
        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(asset.file).pipe(res);
      });
    },
    generateBundle() {
      for (const [assetName, asset] of Object.entries(LOCAL_SCANNER_ASSETS)) {
        if (fs.existsSync(asset.file)) {
          this.emitFile({
            type: 'asset',
            fileName: `ocr-assets/${assetName}`,
            source: fs.readFileSync(asset.file),
          });
        }
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      localScannerAssetsPlugin(),
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
        manifest: {
          id: '/',
          name: 'PaketScan — Video till Excel',
          short_name: 'PaketScan',
          description:
            'Filma streckkoder och delivery- eller removalpaket helt lokalt och offline och omvandla automatiskt till Excel och anteckningar.',
          theme_color: '#0284c7',
          background_color: '#f8fafc',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,wasm,gz}'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallbackDenylist: [/^\/api\//, /^\/ocr-assets\//],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, '.'),
      },
    },
    server: {
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      ws: process.env.DISABLE_HMR === 'true' ? (false as const) : undefined,
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
