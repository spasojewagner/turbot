import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

/**
 * TODO(faza #2): gemini-1.5-flash je ugašen — svi pozivi vraćaju 404.
 * Migracija je samo izmena env varijable, bez diranja koda.
 */
export const CHAT_MODEL = process.env.CHAT_MODEL ?? 'gemini-1.5-flash';

/** Koliko konteksta iz dokumenata šaljemo modelu. */
const MAX_CONTEXT_CHARS = 6_000;
/** Koliko poslednjih razmena istorije zadržavamo. */
const HISTORY_TURNS = 3;
/** Gornja granica po poruci u istoriji. */
const MAX_HISTORY_CHARS_PER_TURN = 500;

export interface ChainInput {
  question: string;
  chat_history?: [string, string][];
}

// ---------------------------------------------------------------------------
// Prompt šabloni
// ---------------------------------------------------------------------------

const NATURAL_CONVERSATION_PROMPT = PromptTemplate.fromTemplate(`
Evo šta sam pronašao u dokumentima: {context}

{chat_history}

Korisnik pita: {question}

Odgovori prirodno kao da objašnjavaš prijatelju. Nemoj da kažeš "u tekstu stoji" ili "prema dokumentu" - samo objasni direktno šta znaš. Budi opušten ali informativan. Ako nešto nije jasno, reci "nisam siguran" umesto formalnih fraza.`);

const CASUAL_PROMPT = PromptTemplate.fromTemplate(`
Kontekst iz dokumenata: {context}

Prethodni razgovor: {chat_history}

Pitanje: {question}

Odgovori casual, kao da pišeš poruku prijatelju. Koristi "e", "pa", "znači", "vidi ovako" - prirodno. Nemoj suvoparne formalnosti.`);

const FRIENDLY_EXPERT_PROMPT = PromptTemplate.fromTemplate(`
Informacije koje imam: {context}

Šta smo do sad pričali: {chat_history}

Ti pitaš: {question}

Objasni kao pametan drug koji zna materiju. Koristi primere, analogije. Umesto "dokumentacija navodi" reci "evo kako to funkcioniše" ili "fora je u tome što".`);

const PERSONAL_ASSISTANT_PROMPT = PromptTemplate.fromTemplate(`
Ono što znam o ovome: {context}

Naš razgovor: {chat_history}

Tvoje pitanje: {question}

Odgovori kao lični asistent koji stvarno želi da pomogne. Budi direktan, precizan, ali topao u komunikaciji. Ako možeš, dodaj savete ili preporuke.`);

// ---------------------------------------------------------------------------
// Formatiranje
// ---------------------------------------------------------------------------

/**
 * ISPRAVKA: ranije je svaki chunk sečen na 250 karaktera, iako se
 * indeksiraju chunkovi od 800. Modelu je stizalo manje od trećine
 * dohvaćenog konteksta. Sada šaljemo cele chunkove do ukupnog budžeta.
 */
const formatDocuments = (docs: Document[]): string => {
  const parts: string[] = [];
  let total = 0;

  for (const doc of docs) {
    const content = doc.pageContent.trim();
    if (!content) continue;

    const source =
      typeof doc.metadata?.source === 'string'
        ? `\n[izvor: ${doc.metadata.source}]`
        : '';
    const block = content + source;

    if (total + block.length > MAX_CONTEXT_CHARS) break;

    parts.push(block);
    total += block.length;
  }

  return parts.join('\n\n---\n\n');
};

/**
 * ISPRAVKA: ranije je svaka poruka sečena na 80 karaktera, što je
 * istoriju činilo neupotrebljivom ("Ti: Koje ponude imate za Grčk...").
 */
const formatChatHistory = (chatHistory: [string, string][]): string => {
  if (!chatHistory?.length) return '';

  return chatHistory
    .slice(-HISTORY_TURNS)
    .map(
      ([human, ai]) =>
        `Korisnik: ${human.slice(0, MAX_HISTORY_CHARS_PER_TURN)}\n` +
        `Asistent: ${ai.slice(0, MAX_HISTORY_CHARS_PER_TURN)}`,
    )
    .join('\n\n');
};

// ---------------------------------------------------------------------------
// Fabrika lanaca
// ---------------------------------------------------------------------------

const createLLM = (temperature: number, maxOutputTokens: number) =>
  new ChatGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    model: CHAT_MODEL,
    temperature,
    maxRetries: 2,
    maxOutputTokens,
  });

/**
 * Ranije su četiri funkcije ponavljale identičnu RunnableSequence.
 * Sada je struktura na jednom mestu, a razlikuju se samo prompt i parametri.
 */
const createChain = (
  retriever: BaseRetriever,
  prompt: PromptTemplate,
  temperature: number,
  maxOutputTokens: number,
) =>
  RunnableSequence.from([
    {
      context: (input: ChainInput) =>
        retriever.invoke(input.question).then(formatDocuments),
      question: (input: ChainInput) => input.question,
      chat_history: (input: ChainInput) =>
        formatChatHistory(input.chat_history ?? []),
    },
    prompt,
    createLLM(temperature, maxOutputTokens),
    new StringOutputParser(),
  ]);

// ---------------------------------------------------------------------------
// Javni lanci
// ---------------------------------------------------------------------------

export const makeNaturalChain = (retriever: BaseRetriever) =>
  createChain(retriever, NATURAL_CONVERSATION_PROMPT, 0.3, 1024);

export const makeCasualChain = (retriever: BaseRetriever) =>
  createChain(retriever, CASUAL_PROMPT, 0.4, 1024);

export const makeFriendlyExpertChain = (retriever: BaseRetriever) =>
  createChain(retriever, FRIENDLY_EXPERT_PROMPT, 0.25, 1024);

export const makePersonalAssistantChain = (retriever: BaseRetriever) =>
  createChain(retriever, PERSONAL_ASSISTANT_PROMPT, 0.2, 1024);

/**
 * Bira prompt na osnovu dužine pitanja.
 * NAPOMENA: detekcija stila živi i u pages/api/chat.ts — duplirana logika
 * koju treba objediniti u fazi #3.
 */
export const makeAdaptiveChain = (retriever: BaseRetriever) => ({
  invoke: async (input: ChainInput) => {
    const isShort = input.question.length < 50;
    const chain = isShort
      ? makeCasualChain(retriever)
      : makeFriendlyExpertChain(retriever);

    return chain.invoke(input);
  },
});

/**
 * Razmak između poziva ka modelu.
 * NAPOMENA: modul-scope promenljiva ne radi pouzdano na serverless-u —
 * svaka instanca ima svoju kopiju. Zamena Redis-om je u fazi #4.
 */
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1_500;

export const makeConversationalRateLimitedChain = (retriever: BaseRetriever) => {
  const chain = makeFriendlyExpertChain(retriever);

  return {
    invoke: async (input: ChainInput) => {
      const elapsed = Date.now() - lastRequestTime;
      if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise((resolve) =>
          setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed),
        );
      }
      lastRequestTime = Date.now();
      return chain.invoke(input);
    },
  };
};

export const makeChain = makeFriendlyExpertChain;

export {
  makeNaturalChain as makeChainNatural,
  makeCasualChain as makeChainCasual,
  makePersonalAssistantChain as makeChainAssistant,
  makeAdaptiveChain as makeChainAdaptive,
  makeConversationalRateLimitedChain as makeChainSafe,
};