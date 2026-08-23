import type { NextApiRequest, NextApiResponse } from 'next';

import { createLogger, requestIdFrom } from '@/lib/logger';
import { requireAuth, requireBlob } from '@/lib/documents/auth';
import { findDocument, listDocuments } from '@/lib/documents/store';
import { ingestDocument } from '@/lib/documents/ingest';

/**
 * Jedan prolaz kroz obradu.
 *
 * Ne obrađuje ceo dokument, nego ograničen broj fragmenata, pa vraća dokle je
 * stigao. Klijent poziva rutu u petlji dok `done` ne postane tačno.
 *
 * Razlog je vremensko ograničenje serverless funkcije: cenovnik od 1.7 MB ima
 * četrdesetak fragmenata, a embedovanje jednog traje oko dve sekunde.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const log = createLogger(requestIdFrom(req.headers));

  if (!requireBlob(res)) return;
  if (!requireAuth(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metoda nije podržana.' });
  }

  try {
    const requestedId = typeof req.body?.id === 'string' ? req.body.id : null;

    /**
     * Dokumenti u obradi imaju prednost — prvo se dovrši započeto, pa se
     * kreće na sledeći. Inače bi petlja skakala između dokumenata.
     */
    const documents = await listDocuments();

    const record = requestedId
      ? await findDocument(requestedId)
      : documents.find((d) => d.status === 'processing') ??
        [...documents]
          .reverse()
          .find((d) => d.status === 'pending' || d.status === 'failed') ??
        null;

    if (!record) {
      return res.status(200).json({
        done: true,
        finished: true,
        message: 'Nema dokumenata na čekanju.',
      });
    }

    const progress = await ingestDocument(record);

    log.info(progress.done ? 'Dokument obrađen' : 'Prolaz završen', {
      id: record.id,
      filename: record.filename,
      napredak: `${progress.chunkDone}/${progress.chunkTotal}`,
      poreklo: progress.extraction,
    });

    const preostalo = (await listDocuments()).filter(
      (d) => d.status === 'pending' || d.status === 'processing' || d.status === 'failed',
    ).length;

    return res.status(200).json({
      // `done` se odnosi na trenutni dokument, `finished` na ceo posao.
      done: progress.done,
      finished: progress.done && preostalo === 0,
      current: {
        id: record.id,
        filename: record.filename,
        chunkDone: progress.chunkDone,
        chunkTotal: progress.chunkTotal,
        extraction: progress.extraction,
      },
      preostalo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Ingestija pala', { greska: message });

    /**
     * Status 200 namerno: klijent u petlji treba da pročita grešku i stane.
     * Sa 5xx bi je pomešao sa mrežnim problemom i nastavio da pokušava.
     */
    return res.status(200).json({
      done: false,
      finished: true,
      error: message.slice(0, 300),
    });
  }
}

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};