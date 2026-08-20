import type { NextApiRequest, NextApiResponse } from 'next';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { PineconeStore } from '@langchain/pinecone';
import { Pinecone } from '@pinecone-database/pinecone';

import { streamAnswer, type SearchFn, type StreamEvent } from '@/utils/makechain';
import { normalizeHistory } from '@/lib/rag/format';
import { PINECONE_NAME_SPACE } from '@/config/pinecone';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_INDEX_NAME_OVERRIDE = process.env.PINECONE_INDEX_NAME!;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001';

const MAX_QUESTION_LENGTH = 600;
const RETRIEVAL_K = Number(process.env.RETRIEVAL_K ?? 12);
const MAX_HISTORY_TURNS = 12;

// ---------------------------------------------------------------------------
// Keš
// ---------------------------------------------------------------------------

let cachedEmbeddings: GoogleGenerativeAIEmbeddings | null = null;
let cachedVectorStore: PineconeStore | null = null;
let lastInitTime = 0;
const CACHE_DURATION = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rate limiting po IP adresi
// ---------------------------------------------------------------------------

const MAX_REQUESTS_PER_MINUTE = 15;
const WINDOW_SIZE = 60 * 1000;
const MAX_TRACKED_CLIENTS = 5_000;

const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.socket.remoteAddress ?? 'unknown';
}

function checkRateLimit(ip: string) {
  const now = Date.now();

  if (rateLimitBuckets.size > MAX_TRACKED_CLIENTS) {
    for (const [key, bucket] of rateLimitBuckets) {
      if (now - bucket.windowStart > WINDOW_SIZE) rateLimitBuckets.delete(key);
    }
  }

  const bucket = rateLimitBuckets.get(ip);

  if (!bucket || now - bucket.windowStart > WINDOW_SIZE) {
    rateLimitBuckets.set(ip, { count: 1, windowStart: now });
    return { allowed: true, retryAfter: 0 };
  }

  if (bucket.count >= MAX_REQUESTS_PER_MINUTE) {
    return {
      allowed: false,
      retryAfter: Math.ceil((WINDOW_SIZE - (now - bucket.windowStart)) / 1000),
    };
  }

  bucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

// ---------------------------------------------------------------------------

async function getVectorStore(): Promise<PineconeStore> {
  const isStale = Date.now() - lastInitTime > CACHE_DURATION;

  if (cachedVectorStore && cachedEmbeddings && !isStale) return cachedVectorStore;

  console.log(`Inicijalizacija vector store-a (${EMBEDDING_MODEL})...`);

  cachedEmbeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: GEMINI_API_KEY,
    model: EMBEDDING_MODEL,
    maxRetries: 2,
    maxConcurrency: 1,
  });

  const pineconeClient = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pineconeClient.Index(PINECONE_INDEX_NAME_OVERRIDE);

  cachedVectorStore = await PineconeStore.fromExistingIndex(cachedEmbeddings, {
    // TODO: ukloniti `as any` nakon usklađivanja verzija Pinecone paketa.
    pineconeIndex: index as any,
    textKey: 'text',
    namespace: PINECONE_NAME_SPACE,
  });

  lastInitTime = Date.now();
  return cachedVectorStore;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Samo POST zahtevi su dozvoljeni' });
  }

  const { question, history, debug } = req.body ?? {};

  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Treba mi pitanje da mogu da odgovorim.' });
  }

  const rateLimit = checkRateLimit(getClientIp(req));

  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', rateLimit.retryAfter);
    return res.status(429).json({
      error: 'Previše pitanja u kratkom vremenu. Sačekaj minut.',
      retryAfter: rateLimit.retryAfter,
    });
  }

  const sanitizedQuestion = question.trim().slice(0, MAX_QUESTION_LENGTH);
  const chatHistory = normalizeHistory(history, MAX_HISTORY_TURNS);

  /**
   * NDJSON: jedan JSON objekat po redu.
   *
   * Prostiji od Server-Sent Events i dovoljan ovde, jer je veza jednosmerna
   * i traje koliko i jedan odgovor. Klijent deli po prelomu reda i parsira
   * red po red.
   */
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Sprečava bafering na obrnutim proksijima poput nginxa.
    'X-Accel-Buffering': 'no',
  });

  const send = (event: StreamEvent) => {
    res.write(`${JSON.stringify(event)}\n`);
  };

  // Ako korisnik zatvori vezu, prekidamo posao umesto da trošimo kvotu.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const vectorStore = await getVectorStore();
    const search: SearchFn = (query, k) => vectorStore.similaritySearchWithScore(query, k);

    for await (const event of streamAnswer({
      question: sanitizedQuestion,
      history: chatHistory,
      search,
      k: RETRIEVAL_K,
      signal: controller.signal,
    })) {
      if (controller.signal.aborted) break;

      // Debug podaci se šalju samo kada su traženi.
      if (event.type === 'done' && !debug) {
        send({ type: 'done', debug: {} });
        continue;
      }

      send(event);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Greška u chat handleru:', message);

    const friendly = message.includes('quota')
      ? 'Dnevna kvota je iskorišćena. Probaj kasnije.'
      : 'Dogodila se greška. Probaj ponovo za malo.';

    send({ type: 'error', message: friendly });
  } finally {
    res.end();
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
    // Obavezno: bez ovoga Next bafferuje odgovor i streaming ne radi.
    responseLimit: false,
  },
  runtime: 'nodejs',
  maxDuration: 60,
};