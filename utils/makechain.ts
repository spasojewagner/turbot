import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { Document } from '@langchain/core/documents';

import {
  diversify,
  formatDocuments,
  parseRouterResponse,
  renderTurns,
  type Intent,
  type SourceRef,
} from '@/lib/rag/format';

// Re-eksport da pages/api/chat.ts ne mora da zna za lib sloj.
export type { Intent, SourceRef };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

export const CHAT_MODEL = process.env.CHAT_MODEL ?? 'gemini-3.6-flash';

/**
 * Poseban, brži model za rutiranje i sažimanje.
 *
 * Ta dva poziva ne traže kvalitet glavnog modela, a sa njim su dodavala po
 * dvadesetak sekundi po zahtevu.
 */
export const UTILITY_MODEL = process.env.UTILITY_MODEL ?? 'gemini-3.1-flash-lite';

const MAX_CONTEXT_CHARS = 14_000;
/** Koliko poslednjih razmena ide doslovno. Starije se sažimaju. */
const VERBATIM_TURNS = 5;
const MAX_TURN_CHARS = 700;
/** Najviše fragmenata iz istog dokumenta. */
const MAX_PER_DOCUMENT = 2;

/**
 * Prag kosinusne sličnosti. Gemini embeddinzi retko padnu ispod 0.6 čak i za
 * slabo povezan tekst — na ovom korpusu dobri pogoci su 0.73–0.78. Menjaj tek
 * kad vidiš stvarne skorove u debug izlazu.
 */
const RELEVANCE_FLOOR = Number(process.env.RELEVANCE_FLOOR ?? 0.62);

export type SearchFn = (query: string, k: number) => Promise<[Document, number][]>;

export interface AnswerResult {
  text: string;
  sources: SourceRef[];
  intent: Intent;
  standaloneQuestion: string;
  topScore: number | null;
  timings: Record<string, number>;
}

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
  apiKey: GEMINI_API_KEY,
  model: CHAT_MODEL,
  temperature: 0.1,
  maxRetries: 2,
  maxOutputTokens: 4096,
});

const asideLLM = new ChatGoogleGenerativeAI({
  apiKey: GEMINI_API_KEY,
  model: UTILITY_MODEL,
  temperature: 0.3,
  maxRetries: 1,
  maxOutputTokens: 2048,
});

const utilityLLM = new ChatGoogleGenerativeAI({
  apiKey: GEMINI_API_KEY,
  model: UTILITY_MODEL,
  temperature: 0,
  maxRetries: 1,
  maxOutputTokens: 2048,
});

const routerChain = ROUTER_PROMPT.pipe(utilityLLM).pipe(new StringOutputParser());
const summaryChain = SUMMARY_PROMPT.pipe(utilityLLM).pipe(new StringOutputParser());
const answerChain = ANSWER_PROMPT.pipe(answerLLM).pipe(new StringOutputParser());
const asideChain = ASIDE_PROMPT.pipe(asideLLM).pipe(new StringOutputParser());

// ---------------------------------------------------------------------------
// Istorija
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

// ---------------------------------------------------------------------------
// Ruter
// ---------------------------------------------------------------------------

async function route(
  question: string,
  historyBlock: string,
): Promise<{ intent: Intent; standaloneQuestion: string }> {
  try {
    const raw = await routerChain.invoke({
      question,
      chat_history: historyBlock || 'Razgovor tek počinje.',
    });

    // Parsiranje je pokriveno testovima i samo pada na siguran default.
    return parseRouterResponse(raw, question);
  } catch (err) {
    console.warn('[router] poziv nije uspeo, koristim cenovnik:', err);
    return { intent: 'cenovnik', standaloneQuestion: question };
  }
}

// ---------------------------------------------------------------------------
// Javni API
// ---------------------------------------------------------------------------

export async function answerQuestion({
  question,
  history = [],
  search,
  k = 12,
}: {
  question: string;
  history?: [string, string][];
  search: SearchFn;
  k?: number;
}): Promise<AnswerResult> {
  const timings: Record<string, number> = {};

  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    const result = await fn();
    timings[name] = Date.now() - start;
    return result;
  };

  const historyBlock = await mark('history', () => buildHistory(history));
  const { intent, standaloneQuestion } = await mark('router', () =>
    route(question, historyBlock),
  );

  // Ćaskanje i pitanja van teme ne diraju vektorsku bazu.
  if (intent === 'razgovor' || intent === 'van_teme') {
    const text = await mark('aside', () =>
      asideChain.invoke({ question, chat_history: historyBlock }),
    );

    return {
      text: text.trim(),
      sources: [],
      intent,
      standaloneQuestion: question,
      topScore: null,
      timings,
    };
  }

  // Traži se šire nego što se koristi, da bi posle filtriranja po dokumentu
  // ostalo dovoljno materijala.
  const scored = await mark('search', () => search(standaloneQuestion, k));
  const topScore = scored.length > 0 ? scored[0][1] : null;

  const relevant = diversify(
    scored.filter(([, score]) => score >= RELEVANCE_FLOOR),
    MAX_PER_DOCUMENT,
  );

  if (relevant.length === 0) {
    return {
      text:
        'U dostupnim cenovnicima nema podataka o tome. Mogu da pretražim po ' +
        'destinaciji, terminu polaska, tipu prevoza ili ceni — probaj sa nekim od toga.',
      sources: [],
      intent,
      standaloneQuestion,
      topScore,
      timings,
    };
  }

  const { context, sources } = formatDocuments(relevant, MAX_CONTEXT_CHARS);

  const text = await mark('answer', () =>
    answerChain.invoke({
      context,
      chat_history: historyBlock,
      question: standaloneQuestion,
    }),
  );

  return { text: text.trim(), sources, intent, standaloneQuestion, topScore, timings };
}