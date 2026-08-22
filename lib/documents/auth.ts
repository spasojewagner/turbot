import type { NextApiRequest, NextApiResponse } from 'next';

import { env } from '@/lib/env';

/**
 * Zaštita administrativnih ruta.
 *
 * Jedan deljeni token, ne pravi sistem naloga. Za jednog administratora je
 * dovoljno; za više njih treba prava autentifikacija.
 *
 * Ako `ADMIN_TOKEN` nije podešen, rute su zatvorene u produkciji i otvorene
 * u razvoju — inače bi lokalni rad tražio podešavanje koje nikome ne treba.
 */
export function isAuthorized(req: NextApiRequest): boolean {
  if (!env.ADMIN_TOKEN) return env.NODE_ENV !== 'production';

  const header = req.headers['x-admin-token'];
  const token = Array.isArray(header) ? header[0] : header;

  return token === env.ADMIN_TOKEN;
}

export function requireAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  if (isAuthorized(req)) return true;

  res.status(401).json({ error: 'Nemaš pristup ovoj ruti.' });
  return false;
}

export function requireBlob(res: NextApiResponse): boolean {
  if (env.BLOB_READ_WRITE_TOKEN) return true;

  res.status(503).json({
    error:
      'Skladište dokumenata nije podešeno. Napravi Blob store u Vercel konzoli, ' +
      'pa pokreni `vercel env pull`.',
  });
  return false;
}