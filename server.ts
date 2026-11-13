import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { analyzeUploadedMedia } from './src/server/geminiScanner';

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(os.tmpdir(), 'paketscan-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 95 * 1024 * 1024, // 95 MB per file
    files: 24,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Endast video- och bildfiler stöds (MP4, WebM, MOV, JPG, PNG).'));
    }
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'PaketScan' });
  });

  app.post(
    '/api/scan-media',
    upload.array('media', 24),
    async (req: Request, res: Response) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const extraHint = typeof req.body?.hint === 'string' ? req.body.hint.trim() : '';

      try {
        if (files.length === 0) {
          res.status(400).json({ error: 'Välj eller spela in en video eller bild innan skanning.' });
          return;
        }

        const result = await analyzeUploadedMedia(
          files.map((f) => ({
            path: f.path,
            mimetype: f.mimetype,
            size: f.size,
            originalname: f.originalname,
          })),
          extraHint
        );

        res.json(result);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Ett oväntat fel uppstod vid analys av videon.';
        const lower = message.toLowerCase();

        if (lower.includes('api_key') || lower.includes('permission_denied') || lower.includes('403')) {
          res.status(403).json({
            error:
              'API-nyckeln saknas eller saknar behörighet. Kontrollera Settings > Secrets i AI Studio.',
          });
          return;
        }
        if (lower.includes('resource_exhausted') || lower.includes('429')) {
          res.status(429).json({
            error:
              'Kvoten för AI-analys är tillfälligt full. Vänta en stund eller kontrollera din API-kvot i Settings > Secrets.',
          });
          return;
        }

        res.status(500).json({ error: message });
      }
    }
  );

  // Multer & validation error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: 'Videofilen är för stor (max 95 MB). Dela upp filmningen i kortare klipp.',
        });
        return;
      }
      res.status(400).json({ error: `Uppladdningsfel: ${err.message}` });
      return;
    }
    const message = err instanceof Error ? err.message : 'Serverfel';
    res.status(400).json({ error: message });
  });

  if (process.env.NODE_ENV !== 'production') {
    app.get('/@vite/client', (_req: Request, res: Response) => {
      res.type('application/javascript').send(`
export class ErrorOverlay {
  close() {}
}
const sheetsMap = new Map();
const linkSheetsMap = new Map();
if (typeof document !== 'undefined') {
  document.querySelectorAll('style[data-vite-dev-id]').forEach((el) => {
    sheetsMap.set(el.getAttribute('data-vite-dev-id'), el);
  });
  document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id]').forEach((el) => {
    linkSheetsMap.set(el.getAttribute('data-vite-dev-id'), el);
  });
}
let lastInsertedStyle;
export function updateStyle(id, content) {
  if (linkSheetsMap.has(id)) return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => { lastInsertedStyle = undefined; }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement('afterend', style);
    }
    lastInsertedStyle = style;
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
export function removeStyle(id) {
  if (linkSheetsMap.has(id)) {
    document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id="' + CSS.escape(id) + '"]').forEach((el) => el.remove());
    linkSheetsMap.delete(id);
  }
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
    data: {},
  };
}
export function injectQuery(url, queryToInject) {
  if (!url || (url[0] !== '.' && url[0] !== '/')) return url;
  const pathname = url.replace(/[?#].*$/, '');
  const parsed = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (parsed.search ? '&' + parsed.search.slice(1) : '') + (parsed.hash || '');
}
`);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false, allowedHosts: true as const },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve('dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PaketScan server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
