import type { NextApiRequest, NextApiResponse } from 'next';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { PineconeStore } from '@langchain/pinecone';
import { Pinecone } from '@pinecone-database/pinecone';

import { answerQuestion, CHAT_MODEL, type SearchFn } from '@/utils/makechain';
import { PINECONE_NAME_SPACE } from '@/config/pinecone';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_INDEX_NAME_OVERRIDE = process.env.PINECONE_INDEX_NAME!;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001';

const MAX_QUESTION_LENGTH = 600;
const RETRIEVAL_K = Number(process.env.RETRIEVAL_K ?? 8);
/** Koliko razmena istorije prihvatamo od klijenta. Starije server sažima. */
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
    return { allowed: true, remaining: MAX_REQUESTS_PER_MINUTE - 1, retryAfter: 0 };
  }

  if (bucket.count >= MAX_REQUESTS_PER_MINUTE) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((WINDOW_SIZE - (now - bucket.windowStart)) / 1000),
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_MINUTE - bucket.count,
    retryAfter: 0,
  };
}

// ---------------------------------------------------------------------------
// Pomoćne funkcije
// ---------------------------------------------------------------------------

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Nepoznata greška';
}

function normalizeHistory(input: unknown): [string, string][] {
  if (!Array.isArray(input)) return [];

  return input
    .filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string',
    )
    .slice(-MAX_HISTORY_TURNS);
}

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
      friendly: true,
    });
  }

  const sanitizedQuestion = question.trim().slice(0, MAX_QUESTION_LENGTH);
  const chatHistory = normalizeHistory(history);

  try {
    const vectorStore = await getVectorStore();

    /**
     * Skorovi su potrebni da bi se odbacili nerelevantni rezultati, pa se
     * koristi similaritySearchWithScore umesto običnog retrievera.
     */
    const search: SearchFn = (query, k) => vectorStore.similaritySearchWithScore(query, k);

    const startTime = Date.now();

    const { text, sources, intent, standaloneQuestion, topScore } = await answerQuestion({
      question: sanitizedQuestion,
      history: chatHistory,
      search,
      k: RETRIEVAL_K,
    });

    const responseTime = Date.now() - startTime;

    return res.status(200).json({
      text,
      question: sanitizedQuestion,
      intent,
      sourceDocuments: sources.map((source) => ({
        pageContent: source.excerpt,
        metadata: {
          label: source.label,
          filename: source.filename,
          score: Number(source.score.toFixed(3)),
        },
      })),
      debug: debug
        ? {
            chatModel: CHAT_MODEL,
            embeddingModel: EMBEDDING_MODEL,
            index: PINECONE_INDEX_NAME_OVERRIDE,
            k: RETRIEVAL_K,
            responseTime: `${responseTime}ms`,
            intent,
            standaloneQuestion,
            topScore,
            sourcesKept: sources.length,
            historyTurns: chatHistory.length,
            requestsRemaining: rateLimit.remaining,
          }
        : undefined,
    });
  } catch (error: unknown) {
    const message = safeErrorMessage(error);
    console.error('Greška u chat handleru:', message);

    const status = (error as { status?: number })?.status;
    const debugPayload = debug ? { error: message.slice(0, 300) } : undefined;

    if (status === 429 || message.includes('429') || message.includes('quota')) {
      res.setHeader('Retry-After', 7200);
      return res.status(429).json({
        error: 'Dnevna kvota je iskorišćena. Probaj kasnije.',
        retryAfter: 7200,
        friendly: true,
        debug: debugPayload,
      });
    }

    if (message.includes('timeout')) {
      return res.status(408).json({
        error: 'Odgovor je predugo trajao. Probaj ponovo.',
        friendly: true,
        debug: debugPayload,
      });
    }

    return res.status(500).json({
      error: 'Dogodila se greška. Probaj ponovo za malo.',
      friendly: false,
      debug: debugPayload,
    });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
  runtime: 'nodejs',
  maxDuration: 60,
};