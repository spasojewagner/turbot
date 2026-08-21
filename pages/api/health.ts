import type { NextApiRequest, NextApiResponse } from 'next';
import { Pinecone } from '@pinecone-database/pinecone';

import { env } from '@/lib/env';
import { createLogger, requestIdFrom } from '@/lib/logger';

/**
 * Provera stanja aplikacije.
 *
 * `GET /api/health` — plitka provera, bez mrežnih poziva. Ako odgovori,
 * konfiguracija je validna i aplikacija se podigla.
 *
 * `GET /api/health?deep=1` — dodatno pita Pinecone koliko vektora ima u
 * indeksu. Sporije, ali odgovara na pitanje da li je baza zaista puna, što
 * je najčešći uzrok toga da bot tvrdi da nema podataka.
 *
 * Vrednosti ključeva se nikada ne vraćaju — samo da li postoje.
 */

interface Health {
  status: 'ok' | 'degraded';
  time: string;
  config: {
    chatModel: string;
    utilityModel: string;
    embeddingModel: string;
    index: string;
    namespace: string;
    retrievalK: number;
    relevanceFloor: number;
  };
  pinecone?: {
    reachable: boolean;
    vectors?: number;
    dimension?: number;
    error?: string;
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Samo GET zahtevi su dozvoljeni' });
  }

  const log = createLogger(requestIdFrom(req.headers));

  const health: Health = {
    status: 'ok',
    time: new Date().toISOString(),
    config: {
      chatModel: env.CHAT_MODEL,
      utilityModel: env.UTILITY_MODEL,
      embeddingModel: env.EMBEDDING_MODEL,
      index: env.PINECONE_INDEX_NAME,
      namespace: env.PINECONE_NAMESPACE,
      retrievalK: env.RETRIEVAL_K,
      relevanceFloor: env.RELEVANCE_FLOOR,
    },
  };

  const deep = req.query.deep === '1' || req.query.deep === 'true';

  if (deep) {
    try {
      const client = new Pinecone({ apiKey: env.PINECONE_API_KEY });
      const stats = await client.Index(env.PINECONE_INDEX_NAME).describeIndexStats();

      const vectors = stats.namespaces?.[env.PINECONE_NAMESPACE]?.recordCount ?? 0;

      health.pinecone = {
        reachable: true,
        vectors,
        dimension: stats.dimension,
      };

      // Prazan indeks znači da bot radi, ali nema šta da odgovori.
      if (vectors === 0) {
        health.status = 'degraded';
        log.warn('Indeks je prazan', { index: env.PINECONE_INDEX_NAME });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      health.status = 'degraded';
      health.pinecone = { reachable: false, error: message.slice(0, 200) };
      log.error('Pinecone nedostupan', { greska: message });
    }
  }

  // Health se ne kešira — poenta je da pokazuje trenutno stanje.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(health.status === 'ok' ? 200 : 503).json(health);
}
