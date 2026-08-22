import type { NextApiRequest, NextApiResponse } from 'next';

import { createLogger, requestIdFrom } from '@/lib/logger';
import { requireAuth, requireBlob } from '@/lib/documents/auth';
import { listDocuments, uploadDocument } from '@/lib/documents/store';

/** Gornja granica veličine jednog cenovnika. */
const MAX_BYTES = 20 * 1024 * 1024;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const log = createLogger(requestIdFrom(req.headers));

  if (!requireBlob(res)) return;
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    try {
      const documents = await listDocuments();
      return res.status(200).json({ documents });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Spisak dokumenata nije uspeo', { greska: message });
      return res.status(500).json({ error: message });
    }
  }

  if (req.method === 'POST') {
    try {
      const filename = decodeURIComponent(
        String(req.query.filename ?? 'dokument.pdf'),
      );

      if (!filename.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({ error: 'Prihvataju se samo PDF fajlovi.' });
      }

      /**
       * Telo se čita ručno jer je `bodyParser` isključen — ugrađeni parser
       * bi binarni sadržaj pokvario pokušavajući da ga protumači kao tekst.
       */
      const chunks: Buffer[] = [];
      let total = 0;

      for await (const chunk of req) {
        total += chunk.length;

        if (total > MAX_BYTES) {
          return res
            .status(413)
            .json({ error: `Fajl je veći od ${MAX_BYTES / 1024 / 1024} MB.` });
        }

        chunks.push(chunk as Buffer);
      }

      if (total === 0) {
        return res.status(400).json({ error: 'Telo zahteva je prazno.' });
      }

      const { document, duplicate } = await uploadDocument(
        filename,
        Buffer.concat(chunks),
      );

      log.info(duplicate ? 'Dokument već postoji' : 'Dokument dodat', {
        id: document.id,
        filename: document.filename,
        kb: Math.round(document.size / 1024),
      });

      return res.status(duplicate ? 200 : 201).json({ document, duplicate });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Dodavanje dokumenta nije uspelo', { greska: message });
      return res.status(500).json({ error: message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Metoda nije podržana.' });
}

export const config = {
  api: {
    // Binarni sadržaj se čita iz sirovog toka, ne kroz parser.
    bodyParser: false,
  },
  runtime: 'nodejs',
  maxDuration: 60,
};