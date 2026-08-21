import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { Document } from '@langchain/core/documents';

import { env } from '@/lib/env';
import {
  diversify,
  formatDocuments,
  parseRouterResponse,
  perDocumentLimit,
  quickRoute,
  renderTurns,
  type Intent,
  type SourceRef,
} from '@/lib/rag/format';

// Re-eksport da pages/api/chat.ts ne mora da zna za lib sloj.
export type { Intent, SourceRef };

export const CHAT_MODEL = env.CHAT_MODEL;
export const UTILITY_MODEL = env.UTILITY_MODEL;

const MAX_CONTEXT_CHARS = 14_000;
/** Koliko poslednjih razmena ide doslovno. Starije se sažimaju. */
const VERBATIM_TURNS = 5;
const MAX_TURN_CHARS = 700;

export type SearchFn = (query: string, k: number) => Promise<[Document, number][]>;

/** Faza obrade — klijent je prikazuje dok čeka prvi token. */
export type Stage = 'razumevanje' | 'pretraga' | 'sastavljanje';

export type StreamEvent =
  | { type: 'status'; stage: Stage }
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'token'; text: string }
  | { type: 'done'; debug: Record<string, unknown> }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Promptovi
// ---------------------------------------------------------------------------

const ROUTER_PROMPT = PromptTemplate.fromTemplate(`
Ti si klasifikator za asistenta turističke agencije.

{chat_history}

Novo korisnikovo pitanje: {question}

Odredi nameru:
- "cenovnik" — pita o aranžmanima, cenama, terminima, destinacijama, prevozu, hotelima, uslovima putovanja
- "nastavak" — nadovezuje se na prethodni odgovor o aranžmanima ("a koliko to košta", "šta je uključeno")
- "razgovor" — pozdrav, zahvala, pitanje o tome šta asistent ume
- "van_teme" — sve ostalo: računanje, opšte znanje, teme koje nisu putovanja

Zatim napiši samostalno pitanje:
- za "nastavak" razreši zamenice pomoću istorije i zadrži destinaciju i termin iz prethodnog pitanja
- za "cenovnik" ostavi pitanje uglavnom nepromenjeno
- za "razgovor" i "van_teme" prepiši pitanje DOSLOVNO, bez ikakvog dopunjavanja iz istorije

Odgovori isključivo JSON objektom, bez markdown ograda:
{{"namera": "...", "pitanje": "..."}}`);

const ANSWER_PROMPT = PromptTemplate.fromTemplate(`
Ti si asistent turističke agencije. Odgovaraš isključivo na osnovu priloženih izvoda iz cenovnika i programa putovanja.

Pravila:
- Navodi konkretne podatke: cene sa valutom, datume polaska i povratka, broj noćenja, tip prevoza, šta je uključeno u cenu.
- Iznose prepiši tačno onako kako stoje u izvorima. Ne zaokružuj, ne preračunavaj i ne procenjuj.
- Kada navodiš cenu, naznači na koji se aranžman i koji termin odnosi.
- Ako traženi podatak ne postoji u izvorima, reci to jasno. Alternativu predloži samo ako je stvarno srodna onome što je traženo.
- Nikada ne izmišljaj cene, termine, hotele ni uslove putovanja.
- Kada nabrajaš više aranžmana, koristi listu.
- Piši sažeto. Bez marketinškog jezika, bez familijarnog obraćanja, bez emojija.

Izvori:
{context}

{chat_history}

Pitanje: {question}

Odgovor:`);

const ASIDE_PROMPT = PromptTemplate.fromTemplate(`
Ti si TurBot, asistent turističke agencije. Pretražuješ cenovnike i programe putovanja i odgovaraš na pitanja o aranžmanima.

{chat_history}

Korisnik kaže: {question}

Odgovori kratko i prirodno, u jednoj do dve rečenice. Ako je pitanje van tvoje teme, odgovori na njega ako umeš, pa u istoj poruci nenametljivo podseti šta možeš da nađeš u cenovnicima. Bez emojija, bez uzvika, bez nabrajanja.`);

const SUMMARY_PROMPT = PromptTemplate.fromTemplate(`
Sažmi ovaj deo razgovora između korisnika i asistenta turističke agencije u najviše četiri rečenice.

Zadrži: destinacije, termine, cene i uslove koji su pomenuti, i šta korisnik traži.
Izostavi: uljudne fraze i formulacije.

{transcript}

Sažetak:`);

// ---------------------------------------------------------------------------
// Modeli
//
// Budžeti tokena su namerno velikodušni: Gemini 3.x troši deo izlaza na
// interno rezonovanje pre nego što išta ispiše. Sa 300 tokena odgovor je
// stizao prekinut usred rečenice.
// ---------------------------------------------------------------------------

const answerLLM = new ChatGoogleGenerativeAI({
  apiKey: env.GEMINI_API_KEY,
  model: env.CHAT_MODEL,
  temperature: 0.1,
  maxRetries: 2,
  maxOutputTokens: 8192,
});

const asideLLM = new ChatGoogleGenerativeAI({
  apiKey: env.GEMINI_API_KEY,
  model: env.UTILITY_MODEL,
  temperature: 0.3,
  maxRetries: 1,
  maxOutputTokens: 2048,
});

const utilityLLM = new ChatGoogleGenerativeAI({
  apiKey: env.GEMINI_API_KEY,
  model: env.UTILITY_MODEL,
  temperature: 0,
  maxRetries: 1,
  maxOutputTokens: 2048,
});

const routerChain = ROUTER_PROMPT.pipe(utilityLLM).pipe(new StringOutputParser());
const summaryChain = SUMMARY_PROMPT.pipe(utilityLLM).pipe(new StringOutputParser());
const answerChain = ANSWER_PROMPT.pipe(answerLLM).pipe(new StringOutputParser());
const asideChain = ASIDE_PROMPT.pipe(asideLLM).pipe(new StringOutputParser());

// ---------------------------------------------------------------------------
// Istorija i rutiranje
// ---------------------------------------------------------------------------

/**
 * Poslednjih nekoliko razmena ide doslovno, sve pre toga u sažetak.
 * Bez toga duži razgovor ili preplavi kontekst ili se tiho odseca.
 */
async function buildHistory(history: [string, string][]): Promise<string> {
  if (!history?.length) return '';

  const recent = history.slice(-VERBATIM_TURNS);
  const older = history.slice(0, -VERBATIM_TURNS);

  let block = `Prethodni razgovor:\n${renderTurns(recent, MAX_TURN_CHARS)}\n`;

  if (older.length > 0) {
    try {
      const summary = await summaryChain.invoke({
        transcript: renderTurns(older, MAX_TURN_CHARS),
      });
      block = `Ranije u razgovoru (sažetak):\n${summary.trim()}\n\n${block}`;
    } catch {
      // Ako sažimanje padne, radimo samo sa skorašnjim razmenama.
    }
  }

  return block;
}

async function route(
  question: string,
  historyBlock: string,
  hasHistory: boolean,
): Promise<{ intent: Intent; standaloneQuestion: string }> {
  // Većina stvarnih pitanja se prepoznaje bez poziva modelu.
  const brzi = quickRoute(question, hasHistory);
  if (brzi) return { intent: brzi, standaloneQuestion: question };

  try {
    const raw = await routerChain.invoke({
      question,
      chat_history: historyBlock || 'Razgovor tek počinje.',
    });

    return parseRouterResponse(raw, question);
  } catch (err) {
    console.warn('[router] poziv nije uspeo, koristim cenovnik:', err);
    return { intent: 'cenovnik', standaloneQuestion: question };
  }
}

// ---------------------------------------------------------------------------
// Javni API
// ---------------------------------------------------------------------------

/**
 * Odgovara na pitanje i emituje događaje kako obrada odmiče.
 *
 * Streaming je ovde više od kozmetike: ruter i pretraga zajedno traju
 * nekoliko sekundi pre nego što model počne da piše, pa bi bez statusa
 * korisnik gledao u prazno.
 */
export async function* streamAnswer({
  question,
  history = [],
  search,
  k = env.RETRIEVAL_K,
  signal,
}: {
  question: string;
  history?: [string, string][];
  search: SearchFn;
  k?: number;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const timings: Record<string, number> = {};
  const started = Date.now();
  const mark = (name: string, from: number) => {
    timings[name] = Date.now() - from;
  };

  try {
    yield { type: 'status', stage: 'razumevanje' };

    const t0 = Date.now();
    const historyBlock = await buildHistory(history);
    const { intent, standaloneQuestion } = await route(
      question,
      historyBlock,
      history.length > 0,
    );
    mark('router', t0);

    // Ćaskanje i pitanja van teme ne diraju vektorsku bazu.
    if (intent === 'razgovor' || intent === 'van_teme') {
      yield { type: 'status', stage: 'sastavljanje' };

      const t1 = Date.now();
      const asideStream = await asideChain.stream({
        question,
        chat_history: historyBlock,
      });

      for await (const chunk of asideStream) {
        if (signal?.aborted) return;
        if (chunk) yield { type: 'token', text: chunk };
      }
      mark('answer', t1);

      yield {
        type: 'done',
        debug: {
          intent,
          standaloneQuestion: question,
          model: env.UTILITY_MODEL,
          timings,
          total: Date.now() - started,
        },
      };
      return;
    }

    yield { type: 'status', stage: 'pretraga' };

    const t2 = Date.now();
    const scored = await search(standaloneQuestion, k);
    mark('search', t2);

    const topScore = scored.length > 0 ? scored[0][1] : null;
    const limit = perDocumentLimit(standaloneQuestion);

    const relevant = diversify(
      scored.filter(([, score]) => score >= env.RELEVANCE_FLOOR),
      limit,
    );

    if (relevant.length === 0) {
      yield {
        type: 'token',
        text:
          'U dostupnim cenovnicima nema podataka o tome. Mogu da pretražim po ' +
          'destinaciji, terminu polaska, tipu prevoza ili ceni — probaj sa nekim od toga.',
      };
      yield {
        type: 'done',
        debug: { intent, standaloneQuestion, topScore, sourcesKept: 0, timings },
      };
      return;
    }

    const { context, sources } = formatDocuments(relevant, MAX_CONTEXT_CHARS);

    // Izvori idu pre teksta, pa klijent može odmah da ih prikaže.
    yield { type: 'sources', sources };
    yield { type: 'status', stage: 'sastavljanje' };

    const t3 = Date.now();
    const answerStream = await answerChain.stream({
      context,
      chat_history: historyBlock,
      question: standaloneQuestion,
    });

    for await (const chunk of answerStream) {
      if (signal?.aborted) return;
      if (chunk) yield { type: 'token', text: chunk };
    }
    mark('answer', t3);

    yield {
      type: 'done',
      debug: {
        intent,
        standaloneQuestion,
        topScore,
        perDocumentLimit: limit,
        sourcesKept: sources.length,
        model: env.CHAT_MODEL,
        timings,
        total: Date.now() - started,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stream] greška:', message);
    yield { type: 'error', message };
  }
}