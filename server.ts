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

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
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
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
