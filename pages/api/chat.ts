import type { NextApiRequest, NextApiResponse } from 'next';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { PineconeStore } from '@langchain/pinecone';
import { Pinecone } from '@pinecone-database/pinecone';

import { answerQuestion, CHAT_MODEL } from '@/utils/makechain';
import { PINECONE_NAME_SPACE } from '@/config/pinecone';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_INDEX_NAME_OVERRIDE = process.env.PINECONE_INDEX_NAME!;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001';

const MAX_QUESTION_LENGTH = 600;

/**
 * Broj fragmenata koji ide modelu.
 *
 * Ranije je bilo 2–4, što je bilo premalo za cenovnike: tabela sa cenama
 * i opis aranžmana često završe u različitim fragmentima, pa je model
 * dobijao opis bez brojeva. Osam daje dovoljno pokrivenosti, a i dalje
 * staje u budžet konteksta.
 */
const RETRIEVAL_K = Number(process.env.RETRIEVAL_K ?? 8);

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
    .slice(-3);
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
    const retriever = vectorStore.asRetriever({
      k: RETRIEVAL_K,
      searchType: 'similarity',
    });

    const startTime = Date.now();

    const { text, sources, standaloneQuestion } = await answerQuestion({
      question: sanitizedQuestion,
      history: chatHistory,
      retriever,
    });

    const responseTime = Date.now() - startTime;

    return res.status(200).json({
      text,
      question: sanitizedQuestion,
      // Klijent prikazuje izvore u accordion sekciji ispod odgovora.
      sourceDocuments: sources.map((source) => ({
        pageContent: source.excerpt,
        metadata: { label: source.label, filename: source.filename },
      })),
      debug: debug
        ? {
            chatModel: CHAT_MODEL,
            embeddingModel: EMBEDDING_MODEL,
            index: PINECONE_INDEX_NAME_OVERRIDE,
            k: RETRIEVAL_K,
            responseTime: `${responseTime}ms`,
            sourcesUsed: sources.length,
            requestsRemaining: rateLimit.remaining,
            standaloneQuestion,
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