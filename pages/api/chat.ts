import type { NextApiRequest, NextApiResponse } from 'next';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { PineconeStore } from '@langchain/pinecone';
import { Pinecone } from '@pinecone-database/pinecone';
import {
  makeFriendlyExpertChain,
  makeCasualChain,
  makePersonalAssistantChain,
  CHAT_MODEL,
} from '@/utils/makechain';
import { PINECONE_NAME_SPACE } from '@/config/pinecone';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_INDEX_NAME_OVERRIDE = process.env.PINECONE_INDEX_NAME!;

/** TODO(faza #2): text-embedding-004 je ugašen 14.01.2026. */
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-004';

const MAX_QUESTION_LENGTH = 600;

// ---------------------------------------------------------------------------
// Keš
// NAPOMENA: modul-scope keš živi samo dok je serverless instanca topla.
// Radi kao optimizacija, ne kao garancija. Faza #4 uvodi Redis.
// ---------------------------------------------------------------------------

let cachedEmbeddings: GoogleGenerativeAIEmbeddings | null = null;
let cachedVectorStore: PineconeStore | null = null;
let lastInitTime = 0;
const CACHE_DURATION = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rate limiting
// ISPRAVKA: ranije jedan globalni brojač za sve korisnike — jedan korisnik
// je trošio kvotu svima. Sada je po IP adresi.
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

function pruneExpiredBuckets(now: number): void {
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart > WINDOW_SIZE) rateLimitBuckets.delete(ip);
  }
}

function checkRateLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
} {
  const now = Date.now();

  if (rateLimitBuckets.size > MAX_TRACKED_CLIENTS) pruneExpiredBuckets(now);

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
// Detekcija stila
// ISPRAVKA: ranije je uslov `q.includes('e ')` hvatao skoro svaku srpsku
// rečenicu ("Koje su cene?", "Gde je hotel?"), pa je gotovo sve završavalo
// kao 'casual' — grane 'expert' i 'assistant' su bile mrtav kod.
// ---------------------------------------------------------------------------

type ConversationStyle = 'casual' | 'expert' | 'assistant';

const VALID_STYLES: readonly ConversationStyle[] = ['casual', 'expert', 'assistant'];

const CASUAL_PATTERN =
  /(\bajde\b|\bhajde\b|\bbre\b|\bbaš\b|\bkolko\b|\bjel\b|\bje l'|\bcao\b|\bćao\b|\bzdravo\b)/i;

const ASSISTANT_PATTERN =
  /(\bmožeš li\b|\bmozes li\b|\bpomozi\b|\btreba mi\b|\btrebam\b|\bpreporuč|\bpreporuc|\bsavet|\bpredloži|\bpredlozi)/i;

function detectConversationStyle(question: string): ConversationStyle {
  if (ASSISTANT_PATTERN.test(question)) return 'assistant';
  if (CASUAL_PATTERN.test(question)) return 'casual';
  return 'expert';
}

function resolveStyle(requested: unknown, question: string): ConversationStyle {
  if (
    typeof requested === 'string' &&
    VALID_STYLES.includes(requested as ConversationStyle)
  ) {
    return requested as ConversationStyle;
  }
  return detectConversationStyle(question);
}

// ---------------------------------------------------------------------------
// Pomoćne funkcije
// ---------------------------------------------------------------------------

/** ISPRAVKA: error.message.substring() je pucao kada message ne postoji. */
function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Nepoznata greška';
}

function selectDocumentCount(question: string): number {
  const complexity =
    (question.match(/\?/g) ?? []).length +
    (question.match(/\b(kako|zašto|šta|kada|gde|koji)\b/gi) ?? []).length;

  if (question.length > 200 || complexity > 2) return 4;
  if (question.length > 100 || complexity > 1) return 3;
  return 2;
}

async function getVectorStore(): Promise<PineconeStore> {
  const isStale = Date.now() - lastInitTime > CACHE_DURATION;

  if (cachedVectorStore && cachedEmbeddings && !isStale) {
    return cachedVectorStore;
  }

  console.log('Inicijalizacija vector store-a...');

  cachedEmbeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: GEMINI_API_KEY,
    model: EMBEDDING_MODEL,
    maxRetries: 2,
    maxConcurrency: 1,
  });

  const pineconeClient = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pineconeClient.Index(PINECONE_INDEX_NAME_OVERRIDE);

  cachedVectorStore = await PineconeStore.fromExistingIndex(cachedEmbeddings, {
    // TODO(faza #2): ukloniti `as any` nakon usklađivanja verzija
    // @pinecone-database/pinecone i @langchain/pinecone.
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // ISPRAVKA: provera metode MORA biti pre čitanja req.body.
  // Kod GET zahteva req.body je undefined, pa je destrukturiranje
  // bacalo TypeError i vraćalo 500 umesto 405.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Samo POST zahtevi su dozvoljeni' });
  }

  const { question, history, debug, style } = req.body ?? {};

  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Treba mi pitanje da mogu da odgovorim.' });
  }

  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);

  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', rateLimit.retryAfter);
    return res.status(429).json({
      error: 'Previše pitanja u kratkom vremenu. Sačekaj minut.',
      retryAfter: rateLimit.retryAfter,
      friendly: true,
    });
  }

  const sanitizedQuestion = question.trim().slice(0, MAX_QUESTION_LENGTH);
  const chatHistory: [string, string][] = Array.isArray(history)
    ? history.slice(-3)
    : [];

  try {
    const vectorStore = await getVectorStore();
    const k = selectDocumentCount(sanitizedQuestion);

    const retriever = vectorStore.asRetriever({ k, searchType: 'similarity' });

    const conversationStyle = resolveStyle(style, sanitizedQuestion);

    const chain =
      conversationStyle === 'casual'
        ? makeCasualChain(retriever)
        : conversationStyle === 'assistant'
          ? makePersonalAssistantChain(retriever)
          : makeFriendlyExpertChain(retriever);

    const startTime = Date.now();

    // ISPRAVKA: uklonjeno sečenje odgovora na 1200 karaktera.
    // maxOutputTokens u makechain.ts već ograničava dužinu — dvostruko
    // sečenje je proizvodilo odgovore prekinute usred rečenice.
    // Uklonjeno i nasumično dodavanje emojija (30% šanse), koje je
    // unosilo nedeterminizam u odgovore bez ikakve koristi.
    const text = await chain.invoke({
      question: sanitizedQuestion,
      chat_history: chatHistory,
    });

    const responseTime = Date.now() - startTime;

    return res.status(200).json({
      text,
      question: sanitizedQuestion,
      conversationStyle,
      debug: debug
        ? {
            modelUsed: CHAT_MODEL,
            embeddingModel: EMBEDDING_MODEL,
            responseTime: `${responseTime}ms`,
            documentsRetrieved: k,
            requestsRemaining: rateLimit.remaining,
            detectedStyle: conversationStyle,
          }
        : undefined,
    });
  } catch (error: unknown) {
    const message = safeErrorMessage(error);
    console.error('Greška u chat handleru:', message);

    const status = (error as { status?: number })?.status;
    const isQuotaError =
      status === 429 || message.includes('429') || message.includes('quota');

    if (isQuotaError) {
      res.setHeader('Retry-After', 7200);
      return res.status(429).json({
        error: 'Dnevna kvota je iskorišćena. Probaj kasnije.',
        retryAfter: 7200,
        friendly: true,
        debug: debug ? { error: message.slice(0, 200) } : undefined,
      });
    }

    if (message.includes('tokens')) {
      return res.status(400).json({
        error: 'Pitanje je predugačko. Možeš li ga skratiti?',
        friendly: true,
        debug: debug ? { error: message.slice(0, 200) } : undefined,
      });
    }

    if (message.includes('timeout')) {
      return res.status(408).json({
        error: 'Odgovor je predugo trajao. Probaj ponovo.',
        friendly: true,
        debug: debug ? { error: message.slice(0, 200) } : undefined,
      });
    }

    return res.status(500).json({
      error: 'Dogodila se greška. Probaj ponovo za malo.',
      friendly: false,
      debug: debug ? { error: message.slice(0, 200) } : undefined,
    });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
  runtime: 'nodejs',
  maxDuration: 30,
};