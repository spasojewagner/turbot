import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Pinecone } from '@pinecone-database/pinecone';

import { env, OCR_MODEL } from '@/lib/env';
import {
  fetchDocumentBuffer,
  readCachedText,
  updateDocument,
  writeCachedText,
  type DocumentRecord,
} from '@/lib/documents/store';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

/** Ispod ovoliko znakova po strani smatramo da tekstualnog sloja nema. */
const MIN_CHARS_PER_PAGE = 200;

/**
 * Koliko fragmenata se obradi u jednom pozivu.
 *
 * Embedovanje jednog fragmenta traje oko dve sekunde, a serverless funkcija
 * ima gornju granicu od šezdeset. Dvanaest ostavlja prostor za preuzimanje
 * fajla i upis u Pinecone. Veći cenovnici se obrađuju u više prolaza.
 */
const CHUNKS_PER_CALL = Number(process.env.INGEST_CHUNKS_PER_CALL ?? 12);

const EMBED_BATCH = 4;
const EMBED_DELAY_MS = 1200;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OCR_PROMPT = `Izvuci strukturirane podatke iz ovog skeniranog cenovnika turističke agencije na srpskom jeziku.

Cilj je pregledan spisak podataka, ne prepis dokumenta. Izostavi turističke opise gradova i znamenitosti — oni nisu potrebni.

Navedi, ovim redom:

1. NAZIV ARANŽMANA, broj dana i noćenja, tip prevoza.
2. TERMINI I CENE — za svaki hotel i svaki termin poseban red: naziv hotela, kategorija, termin od–do, tip sobe, cena po osobi. Ako postoji i redovna i snižena cena, navedi obe.
3. UKLJUČENO U CENU — kao spisak stavki.
4. NIJE UKLJUČENO U CENU — kao spisak stavki.
5. DOPLATE I POPUSTI — svaka sa tačnim iznosom ili procentom i uslovom.
6. FAKULTATIVNI IZLETI — naziv i cena.
7. NAČIN PLAĆANJA — kratko.

Pravila:
- Svi brojevi moraju biti tačni: cene, datumi, procenti, iznosi taksi.
- Cena nikada ne sme stajati bez hotela i termina na koje se odnosi.
- Zadrži dijakritiku (č, ć, ž, š, đ).
- Ako podatak ne postoji u dokumentu, preskoči tu stavku bez komentara.`;

// ---------------------------------------------------------------------------
// Izvlačenje teksta
// ---------------------------------------------------------------------------

/**
 * Tekst se izvuče jednom i keširа.
 *
 * Kod skeniranih cenovnika je to poziv modelu, dakle plaćen posao. Kod svih
 * ostalih keš omogućava da se ingestija nastavi u sledećem prolazu bez
 * ponovnog preuzimanja i parsiranja PDF-a.
 */
async function getText(
  record: DocumentRecord,
): Promise<{ text: string; extraction: 'pdf' | 'ocr' }> {
  const cached = await readCachedText(record.id);
  if (cached) {
    return { text: cached, extraction: record.extraction ?? 'pdf' };
  }

  const buffer = await fetchDocumentBuffer(record);
  const parsed = await pdfParse(buffer);

  const raw = (parsed.text ?? '').trim();
  const pages = parsed.numpages ?? 1;

  if (Math.round(raw.length / pages) >= MIN_CHARS_PER_PAGE) {
    await writeCachedText(record.id, raw);
    return { text: raw, extraction: 'pdf' };
  }

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: OCR_MODEL });

  const result = await model.generateContent([
    { text: OCR_PROMPT },
    { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } },
  ]);

  const text = result.response.text().trim();

  if (text.length < 100) {
    throw new Error(`Model je vratio premalo teksta (${text.length} znakova)`);
  }

  await writeCachedText(record.id, text);
  return { text, extraction: 'ocr' };
}

// ---------------------------------------------------------------------------
// Fragmentiranje
// ---------------------------------------------------------------------------

function chunkId(documentId: string, position: number, content: string): string {
  return createHash('sha256')
    .update(`${documentId}::${position}::${content}`)
    .digest('hex')
    .slice(0, 40);
}

function toTitle(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/\s*\(kliknuti za prikaz\)\s*/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Podela je determinističa: isti tekst i isti parametri daju iste fragmente
 * istim redom. Zbog toga se ingestija može prekinuti i nastaviti bez rizika
 * da se nešto preskoči ili ponovi.
 *
 * Naziv aranžmana ide na početak svakog fragmenta. Tabele sa cenama su nizovi
 * brojeva koji semantički ne liče ni na jedno pitanje; bez tog zaglavlja ih
 * pretraga nikada ne nađe.
 */
async function buildChunks(
  record: DocumentRecord,
  text: string,
): Promise<{ content: string; index: number }[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
  });

  const title = toTitle(record.filename);
  const parts = await splitter.splitText(text);

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part, index) => ({
      content: title ? `${title}\n\n${part}` : part,
      index,
    }));
}

// ---------------------------------------------------------------------------
// Embedovanje
// ---------------------------------------------------------------------------

/**
 * Vektori se prave preko `embedQuery`, ne `embedDocuments`.
 *
 * Verzija @langchain/google-genai koju koristimo ne parsira odgovor
 * `batchEmbedContents` endpointa za gemini-embedding-001 — vraća prazne
 * nizove bez ikakve greške, pa Pinecone dobija vektor dimenzije nula.
 */
async function embedAll(
  embeddings: GoogleGenerativeAIEmbeddings,
  contents: string[],
): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let i = 0; i < contents.length; i += EMBED_BATCH) {
    const batch = contents.slice(i, i + EMBED_BATCH);
    const result = await Promise.all(batch.map((text) => embeddings.embedQuery(text)));

    const prazni = result.filter((v) => !Array.isArray(v) || v.length === 0).length;
    if (prazni > 0) {
      throw new Error(`Embedding je vratio ${prazni} praznih vektora`);
    }

    vectors.push(...result);

    if (i + EMBED_BATCH < contents.length) await delay(EMBED_DELAY_MS);
  }

  return vectors;
}

// ---------------------------------------------------------------------------
// Ingestija
// ---------------------------------------------------------------------------

export interface IngestProgress {
  done: boolean;
  chunkDone: number;
  chunkTotal: number;
  extraction: 'pdf' | 'ocr';
}

/**
 * Obrada jednog dokumenta, u prolazima.
 *
 * Jedan poziv obradi najviše `CHUNKS_PER_CALL` fragmenata i vrati koliko je
 * ostalo. Pozivalac ponavlja dok `done` ne postane tačno.
 *
 * Ranije je cela obrada morala da stane u jedan zahtev, pa je cenovnik od
 * 1.7 MB obarao funkciju na vremenskom ograničenju.
 */
export async function ingestDocument(record: DocumentRecord): Promise<IngestProgress> {
  const fresh = record.status !== 'processing' || !record.chunkDone;

  try {
    if (fresh) {
      // Ponovna obrada već indeksiranog dokumenta prvo briše stare vektore,
      // inače bi u indeksu ostala dva skupa fragmenata istog sadržaja.
      if (record.chunkIds?.length) {
        await deleteDocumentVectors(record);
      }

      await updateDocument(record.id, {
        status: 'processing',
        chunkDone: 0,
        chunkIds: [],
        error: undefined,
      });
    }

    const { text, extraction } = await getText(record);
    const chunks = await buildChunks(record, text);

    if (chunks.length === 0) {
      throw new Error('Dokument nema upotrebljiv tekst');
    }

    const alreadyDone = fresh ? 0 : (record.chunkDone ?? 0);
    const slice = chunks.slice(alreadyDone, alreadyDone + CHUNKS_PER_CALL);

    if (slice.length === 0) {
      await updateDocument(record.id, {
        status: 'ready',
        chunkTotal: chunks.length,
        chunkDone: chunks.length,
        chunkCount: chunks.length,
        extraction,
      });

      return {
        done: true,
        chunkDone: chunks.length,
        chunkTotal: chunks.length,
        extraction,
      };
    }

    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: env.GEMINI_API_KEY,
      model: env.EMBEDDING_MODEL,
      maxRetries: 5,
      maxConcurrency: 2,
    });

    const vectors = await embedAll(
      embeddings,
      slice.map((c) => c.content),
    );

    const pinecone = new Pinecone({ apiKey: env.PINECONE_API_KEY });
    const namespace = pinecone
      .Index(env.PINECONE_INDEX_NAME)
      .namespace(env.PINECONE_NAMESPACE);

    const ids = slice.map((c) => chunkId(record.id, c.index, c.content));

    await namespace.upsert(
      slice.map((c, i) => ({
        id: ids[i],
        values: vectors[i],
        metadata: {
          // Ključ mora biti `text` — chat čita sa textKey: 'text'.
          text: c.content,
          documentId: record.id,
          filename: record.filename,
          title: toTitle(record.filename),
          extraction,
        },
      })),
    );

    const chunkDone = alreadyDone + slice.length;
    const done = chunkDone >= chunks.length;

    // Postojeći zapis se ponovo čita da bi se ID-jevi dopunili, a ne pregazili.
    const existingIds = fresh ? [] : (record.chunkIds ?? []);

    await updateDocument(record.id, {
      status: done ? 'ready' : 'processing',
      extraction,
      chunkTotal: chunks.length,
      chunkDone,
      chunkCount: done ? chunks.length : undefined,
      chunkIds: [...existingIds, ...ids],
      error: undefined,
    });

    return { done, chunkDone, chunkTotal: chunks.length, extraction };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateDocument(record.id, { status: 'failed', error: message.slice(0, 300) });
    throw err;
  }
}

/**
 * Briše vektore jednog dokumenta iz indeksa.
 *
 * Briše se po listi ID-jeva, ne po metapodacima: filtriranje pri brisanju
 * nije podržano na svim Pinecone nivoima, a lista radi svuda.
 */
export async function deleteDocumentVectors(record: DocumentRecord): Promise<number> {
  const ids = record.chunkIds ?? [];
  if (ids.length === 0) return 0;

  const pinecone = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  const namespace = pinecone
    .Index(env.PINECONE_INDEX_NAME)
    .namespace(env.PINECONE_NAMESPACE);

  // Pinecone prima ograničen broj ID-jeva po pozivu.
  for (let i = 0; i < ids.length; i += 100) {
    await namespace.deleteMany(ids.slice(i, i + 100));
  }

  return ids.length;
}