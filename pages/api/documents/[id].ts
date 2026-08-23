import type { NextApiRequest, NextApiResponse } from 'next';

import { createLogger, requestIdFrom } from '@/lib/logger';
import { requireAuth, requireBlob } from '@/lib/documents/auth';
import { findDocument, removeDocument } from '@/lib/documents/store';
import { deleteDocumentVectors } from '@/lib/documents/ingest';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const log = createLogger(requestIdFrom(req.headers));

  if (!requireBlob(res)) return;
  if (!requireAuth(req, res)) return;

  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Metoda nije podržana.' });
  }

  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'Nedostaje id dokumenta.' });

  try {
    const record = await findDocument(id);
    if (!record) return res.status(404).json({ error: 'Dokument ne postoji.' });

    /**
     * Vektori se brišu pre zapisa.
     *
     * Obrnut redosled bi ostavio vektore bez ijednog traga o tome kojem
     * dokumentu pripadaju — bot bi i dalje odgovarao iz obrisanog cenovnika,
     * a niko ne bi znao odakle to dolazi.
     */
    const obrisanoVektora = await deleteDocumentVectors(record);
    await removeDocument(id);

    log.info('Dokument obrisan', { id, filename: record.filename, obrisanoVektora });

    return res.status(200).json({ ok: true, obrisanoVektora });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Brisanje nije uspelo', { id, greska: message });
    return res.status(500).json({ error: message });
  }
}

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};