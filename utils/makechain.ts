import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

export const CHAT_MODEL = process.env.CHAT_MODEL ?? 'gemini-3.6-flash';

/** Ukupan budžet konteksta koji šaljemo modelu. */
const MAX_CONTEXT_CHARS = 12_000;
/** Koliko poslednjih razmena istorije koristimo. */
const HISTORY_TURNS = 3;
const MAX_HISTORY_CHARS_PER_TURN = 400;

export interface SourceRef {
  label: string;
  filename: string;
  excerpt: string;
}

export interface AnswerResult {
  text: string;
  sources: SourceRef[];
  standaloneQuestion: string;
}

// ---------------------------------------------------------------------------
// Promptovi
// ---------------------------------------------------------------------------

/**
 * Preformulisanje follow-up pitanja u samostalno.
 *
 * Bez ovog koraka u vektorsku pretragu ide sirovo pitanje, pa "a koliko to
 * košta?" nema upotrebljiv signal — pretraga ne zna šta je "to" i vraća
 * nasumične fragmente.
 */
const CONDENSE_PROMPT = PromptTemplate.fromTemplate(`
Prethodni razgovor:
{chat_history}

Novo pitanje: {question}

Preformuliši novo pitanje tako da bude razumljivo samo za sebe, bez konteksta razgovora.
Zadrži sve konkretne pojmove: destinacije, datume, nazive aranžmana, tip prevoza.
Ako je pitanje već samostalno, vrati ga nepromenjeno.
Odgovori isključivo preformulisanim pitanjem, bez uvoda i objašnjenja.`);

/**
 * Jedan prompt umesto ranijih pet "ličnosti".
 * Ton je neutralno-informativan, naglasak na tačnosti brojeva.
 */
const ANSWER_PROMPT = PromptTemplate.fromTemplate(`
Ti si asistent turističke agencije. Odgovaraš isključivo na osnovu priloženih izvoda iz cenovnika i programa putovanja.

Pravila:
- Navodi konkretne podatke: cene sa valutom, datume polaska i povratka, broj noćenja, tip prevoza, šta je uključeno u cenu.
- Iznose prepiši tačno onako kako stoje u izvorima. Ne zaokružuj, ne preračunavaj i ne procenjuj.
- Kada navodiš cenu, naznači na koji se aranžman i koji termin odnosi.
- Ako traženi podatak ne postoji u izvorima, reci to jasno i navedi šta jeste dostupno.
- Nikada ne izmišljaj cene, termine, hotele ni uslove putovanja.
- Kada nabrajaš više stavki ili aranžmana, koristi listu.
- Piši sažeto. Bez marketinškog jezika, bez familijarnog obraćanja, bez emojija.

Izvori:
{context}

{chat_history}

Pitanje: {question}

Odgovor:`);

// ---------------------------------------------------------------------------
// Modeli
// ---------------------------------------------------------------------------

/** Niska temperatura — za faktografske odgovore je kreativnost mana. */
const answerLLM = new ChatGoogleGenerativeAI({
  apiKey: GEMINI_API_KEY,
  model: CHAT_MODEL,
  temperature: 0.1,
  maxRetries: 2,
  maxOutputTokens: 4096,
});

const condenseLLM = new ChatGoogleGenerativeAI({
  apiKey: GEMINI_API_KEY,
  model: CHAT_MODEL,
  temperature: 0,
  maxRetries: 1,
  maxOutputTokens: 128,
});

// ---------------------------------------------------------------------------
// Formatiranje
// ---------------------------------------------------------------------------

const getFilename = (doc: Document): string => {
  const meta = doc.metadata ?? {};
  if (typeof meta.filename === 'string') return meta.filename;
  if (typeof meta.source === 'string') {
    return meta.source.split(/[\\/]/).pop() ?? 'nepoznat izvor';
  }
  return 'nepoznat izvor';
};

/** Čitljiv naziv aranžmana iz imena fajla. */
const toLabel = (filename: string): string =>
  filename
    .replace(/\.pdf$/i, '')
    .replace(/\s*\(kliknuti za prikaz\)\s*/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const formatChatHistory = (chatHistory: [string, string][]): string => {
  if (!chatHistory?.length) return '';

  const turns = chatHistory
    .slice(-HISTORY_TURNS)
    .map(
      ([human, ai]) =>
        `Korisnik: ${human.slice(0, MAX_HISTORY_CHARS_PER_TURN)}\n` +
        `Asistent: ${ai.slice(0, MAX_HISTORY_CHARS_PER_TURN)}`,
    )
    .join('\n\n');

  return `Prethodni razgovor:\n${turns}\n`;
};

/**
 * Numeriše izvore i uz svaki fragment stavlja naziv aranžmana, pa model
 * može da veže cenu za konkretan dokument umesto da je navede bez konteksta.
 */
const formatDocuments = (
  docs: Document[],
): { context: string; sources: SourceRef[] } => {
  const blocks: string[] = [];
  const sources: SourceRef[] = [];
  let total = 0;

  for (const doc of docs) {
    const content = doc.pageContent.trim();
    if (!content) continue;

    const filename = getFilename(doc);
    const label = toLabel(filename);
    const block = `[${blocks.length + 1}] ${label}\n${content}`;

    if (total + block.length > MAX_CONTEXT_CHARS) break;

    blocks.push(block);
    sources.push({ label, filename, excerpt: content.slice(0, 600) });
    total += block.length;
  }

  return { context: blocks.join('\n\n---\n\n'), sources };
};

// ---------------------------------------------------------------------------
// Javni API
// ---------------------------------------------------------------------------

const condenseChain = CONDENSE_PROMPT.pipe(condenseLLM).pipe(new StringOutputParser());
const answerChain = ANSWER_PROMPT.pipe(answerLLM).pipe(new StringOutputParser());

/** Pretvara follow-up u samostalno pitanje. Bez istorije vraća original. */
export async function condenseQuestion(
  question: string,
  history: [string, string][],
): Promise<string> {
  if (!history?.length) return question;

  try {
    const rewritten = await condenseChain.invoke({
      question,
      chat_history: formatChatHistory(history),
    });

    const cleaned = rewritten.trim().replace(/^["']|["']$/g, '');
    return cleaned.length > 3 ? cleaned : question;
  } catch {
    // Ako preformulisanje padne, nastavljamo sa originalnim pitanjem.
    return question;
  }
}

export async function answerQuestion({
  question,
  history = [],
  retriever,
}: {
  question: string;
  history?: [string, string][];
  retriever: BaseRetriever;
}): Promise<AnswerResult> {
  const standaloneQuestion = await condenseQuestion(question, history);

  const docs = await retriever.invoke(standaloneQuestion);
  const { context, sources } = formatDocuments(docs);

  if (!context) {
    return {
      text: 'U dostupnim cenovnicima nisam pronašao podatke koji odgovaraju ovom pitanju.',
      sources: [],
      standaloneQuestion,
    };
  }

  const text = await answerChain.invoke({
    context,
    chat_history: formatChatHistory(history),
    question: standaloneQuestion,
  });

  return { text: text.trim(), sources, standaloneQuestion };
}