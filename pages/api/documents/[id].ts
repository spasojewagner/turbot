import type { NextApiRequest, NextApiResponse } from 'next';

import { createLogger, requestIdFrom } from '@/lib/logger';
import { requireAuth, requireBlob } from '@/lib/documents/auth';
import { findDocument, listDocuments } from '@/lib/documents/store';
import { ingestDocument } from '@/lib/documents/ingest';

/**
 * Obrada dokumenata na čekanju.
 *
 * Namerno obrađuje **jedan po pozivu**. Serverless funkcija ima gornju
 * granicu trajanja, a ingestija jednog cenovnika sa embedovanjem i rate
 * limitima ume da potraje. Klijent poziva rutu u petlji dok ima posla, što
 * je jednostavnije od reda čekanja i dovoljno pri ovom obimu.
 *
 * Granica na kojoj to prestaje da važi: dokumenti od nekoliko stotina
 * strana, ili masovno dodavanje. Tada treba pravi red poslova.
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

    const record = requestedId
      ? await findDocument(requestedId)
      : (await listDocuments())
          .reverse()
          .find((d) => d.status === 'pending' || d.status === 'failed') ?? null;

    if (!record) {
      return res.status(200).json({ done: true, message: 'Nema dokumenata na čekanju.' });
    }

    log.info('Ingestija počela', { id: record.id, filename: record.filename });

    const result = await ingestDocument(record);

    log.info('Ingestija završena', {
      id: record.id,
      fragmenata: result.chunkCount,
      poreklo: result.extraction,
    });

    const preostalo = (await listDocuments()).filter(
      (d) => d.status === 'pending',
    ).length;

    return res.status(200).json({
      done: preostalo === 0,
      processed: {
        id: record.id,
        filename: record.filename,
        chunkCount: result.chunkCount,
        extraction: result.extraction,
      },
      preostalo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Ingestija pala', { greska: message });

    // 200 namerno: klijent u petlji treba da vidi grešku i stane, a ne da
    // je protumači kao mrežni problem i pokušava ponovo.
    return res.status(200).json({ done: false, error: message.slice(0, 300) });
  }
}

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};