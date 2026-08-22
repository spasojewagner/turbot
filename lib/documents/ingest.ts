import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { Document } from '@langchain/core/documents';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Pinecone } from '@pinecone-database/pinecone';

import { env, OCR_MODEL } from '@/lib/env';
import {
  fetchDocumentBuffer,
  readOcrText,
  updateDocument,
  writeOcrText,
  type DocumentRecord,
} from '@/lib/documents/store';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

/** Ispod ovoliko znakova po strani smatramo da tekstualnog sloja nema. */
const MIN_CHARS_PER_PAGE = 200;
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 1500;

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
 * Skenirani cenovnici nemaju tekstualni sloj — `pdf-parse` iz njih izvuče po
 * nekoliko znakova. Za takve se PDF šalje modelu, koji ga čita direktno.
 * Rezultat se keširа, jer je to plaćen poziv.
 */
async function extractText(
  record: DocumentRecord,
  buffer: Buffer,
): Promise<{ text: string; extraction: 'pdf' | 'ocr' }> {
  const parsed = await pdfParse(buffer);
  const raw = (parsed.text ?? '').trim();
  const pages = parsed.numpages ?? 1;

  if (Math.round(raw.length / pages) >= MIN_CHARS_PER_PAGE) {
    return { text: raw, extraction: 'pdf' };
  }

  const cached = await readOcrText(record.id);
  if (cached) return { text: cached, extraction: 'ocr' };

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: OCR_MODEL });

  const result = await model.generateContent([
    { text: OCR_PROMPT },
    {
      inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') },
    },
  ]);

  const text = result.response.text().trim();

  if (text.length < 100) {
    throw new Error(`Model je vratio premalo teksta (${text.length} znakova)`);
  }

  await writeOcrText(record.id, text);
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
 * Naziv aranžmana ide na početak svakog fragmenta.
 *
 * Tabele sa cenama su nizovi brojeva i oznaka koji semantički ne liče ni na
 * jedno pitanje. Bez ovog zaglavlja fragment "HOTEL 3*** / 549€" nikada ne
 * pobedi prozni opis uslova, iako sadrži traženi odgovor.
 */
async function splitIntoChunks(
  record: DocumentRecord,
  text: string,
): Promise<Document[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
  });

  const title = toTitle(record.filename);
  const parts = await splitter.splitText(text);

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(
      (part, index) =>
        new Document({
          pageContent: title ? `${title}\n\n${part}` : part,
          metadata: {
            documentId: record.id,
            filename: record.filename,
            title,
            chunkIndex: index,
          },
        }),
    );
}

// ---------------------------------------------------------------------------
// Upis u Pinecone
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
  docs: Document[],
): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);

    const result = await Promise.all(
      batch.map((doc) => embeddings.embedQuery(doc.pageContent)),
    );

    const prazni = result.filter((v) => !Array.isArray(v) || v.length === 0).length;
    if (prazni > 0) {
      throw new Error(`Embedding je vratio ${prazni} praznih vektora`);
    }

    vectors.push(...result);

    if (i + BATCH_SIZE < docs.length) await delay(BATCH_DELAY_MS);
  }

  return vectors;
}

export interface IngestResult {
  chunkCount: number;
  extraction: 'pdf' | 'ocr';
}

/**
 * Obrada jednog dokumenta od početka do kraja.
 *
 * Deljena je između API rute i CLI skripte, pa se ponašanje ne razilazi
 * između dva načina pokretanja.
 */
export async function ingestDocument(record: DocumentRecord): Promise<IngestResult> {
  await updateDocument(record.id, { status: 'processing', error: undefined });

  try {
    const buffer = await fetchDocumentBuffer(record);
    const { text, extraction } = await extractText(record, buffer);
    const docs = await splitIntoChunks(record, text);

    if (docs.length === 0) {
      throw new Error('Dokument nema upotrebljiv tekst');
    }

    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: env.GEMINI_API_KEY,
      model: env.EMBEDDING_MODEL,
      maxRetries: 5,
      maxConcurrency: 2,
    });

    const vectors = await embedAll(embeddings, docs);

    const pinecone = new Pinecone({ apiKey: env.PINECONE_API_KEY });
    const namespace = pinecone
      .Index(env.PINECONE_INDEX_NAME)
      .namespace(env.PINECONE_NAMESPACE);

    const chunkIds = docs.map((doc, i) => chunkId(record.id, i, doc.pageContent));

    await namespace.upsert(
      docs.map((doc, i) => ({
        id: chunkIds[i],
        values: vectors[i],
        metadata: {
          // Ključ mora biti `text` — chat čita sa textKey: 'text'.
          text: doc.pageContent,
          documentId: record.id,
          filename: record.filename,
          title: String(doc.metadata.title ?? ''),
          extraction,
        },
      })),
    );

    await updateDocument(record.id, {
      status: 'ready',
      extraction,
      chunkCount: docs.length,
      chunkIds,
      error: undefined,
    });

    return { chunkCount: docs.length, extraction };
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