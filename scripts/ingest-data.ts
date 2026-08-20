import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { PineconeStore } from '@langchain/pinecone';
import { Document } from '@langchain/core/documents';
import { Pinecone } from '@pinecone-database/pinecone';

import { CustomPDFLoader } from '@/utils/customPDFLoader';
import { PINECONE_NAME_SPACE } from '@/config/pinecone';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_INDEX_NAME_OVERRIDE = process.env.PINECONE_INDEX_NAME!;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001';

/** TODO(faza #6): zameniti object storage-om, obrisati docs/ iz repoa. */
const SOURCE_DIR = process.env.INGEST_SOURCE_DIR ?? 'docs';

/**
 * Veličina fragmenta.
 *
 * Ranijih 800 znakova je sekao tabele sa cenama na pola, pa je cena završavala
 * u jednom fragmentu a termin i naziv hotela u drugom — model je onda dobijao
 * broj bez konteksta. 1400 sa preklapanjem od 250 drži tabelarni red na okupu.
 */
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 1400);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? 250);

const BATCH_SIZE = 2;
const BATCH_DELAY_MS = 5_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

/** Fajl koji proizvodi `npm run ocr` za skenirane PDF-ove. */
const OCR_SUFFIX = '.ocr.txt';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildChunkId(doc: Document, position: number): string {
  const source =
    typeof doc.metadata?.source === 'string' ? doc.metadata.source : 'unknown';

  return createHash('sha256')
    .update(`${source}::${position}::${doc.pageContent}`)
    .digest('hex')
    .slice(0, 40);
}

function isRateLimitError(message: string): boolean {
  return (
    message.includes('429') ||
    message.includes('Too Many Requests') ||
    message.includes('quota')
  );
}

/**
 * Učitava jedan PDF, ili njegov OCR prepis ako postoji.
 *
 * Skenirani cenovnici nemaju tekstualni sloj — `pdf-parse` iz njih izvuče
 * po nekoliko znakova. Za njih `npm run ocr` unapred napravi `.ocr.txt`,
 * i taj sadržaj ima prednost.
 */
async function loadDocument(file: string): Promise<Document[]> {
  const pdfPath = join(SOURCE_DIR, file);
  const ocrPath = pdfPath.replace(/\.pdf$/i, OCR_SUFFIX);

  if (existsSync(ocrPath)) {
    const text = readFileSync(ocrPath, 'utf8').trim();

    if (text.length > 0) {
      console.log(`  ${file} — OCR prepis (${text.length} znakova)`);
      return [
        new Document({
          pageContent: text,
          metadata: { source: pdfPath, extraction: 'ocr' },
        }),
      ];
    }
  }

  const docs = await new CustomPDFLoader(pdfPath).load();
  const chars = docs.reduce((sum, d) => sum + d.pageContent.length, 0);
  console.log(`  ${file} — tekstualni sloj (${chars} znakova)`);

  return docs.map(
    (doc) =>
      new Document({
        pageContent: doc.pageContent,
        metadata: { ...doc.metadata, source: pdfPath, extraction: 'pdf' },
      }),
  );
}

function enrichMetadata(docs: Document[]): Document[] {
  return docs.map((doc, index) => {
    const source =
      typeof doc.metadata?.source === 'string' ? doc.metadata.source : 'unknown';

    return new Document({
      pageContent: doc.pageContent,
      metadata: {
        ...doc.metadata,
        source,
        filename: basename(source),
        chunkIndex: index,
      },
    });
  });
}

async function upsertInBatches(store: PineconeStore, docs: Document[]): Promise<void> {
  const totalBatches = Math.ceil(docs.length / BATCH_SIZE);
  console.log(`\nUpisujem ${docs.length} fragmenata u ${totalBatches} batch-eva`);

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const ids = batch.map((doc, offset) => buildChunkId(doc, i + offset));

    try {
      await store.addDocuments(batch, { ids });
      console.log(`  batch ${batchNumber}/${totalBatches}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  greška u batch-u ${batchNumber}: ${message}`);

      if (!isRateLimitError(message)) throw err;

      console.warn(`  rate limit — čekam ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
      await delay(RATE_LIMIT_BACKOFF_MS);

      await store.addDocuments(batch, { ids });
      console.log(`  batch ${batchNumber}/${totalBatches} iz drugog pokušaja`);
    }

    if (i + BATCH_SIZE < docs.length) await delay(BATCH_DELAY_MS);
  }
}

export async function runIngestion(): Promise<void> {
  const files = readdirSync(SOURCE_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));

  console.log(`Učitavam ${files.length} dokumenata iz "${SOURCE_DIR}"...\n`);

  const rawDocs: Document[] = [];
  let ocrCount = 0;

  for (const file of files) {
    try {
      const docs = await loadDocument(file);
      if (docs[0]?.metadata?.extraction === 'ocr') ocrCount += 1;
      rawDocs.push(...docs);
    } catch (err) {
      console.error(`  ${file} — NEUSPEH: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (rawDocs.length === 0) {
    console.warn('Nema dokumenata za obradu — prekidam.');
    return;
  }

  console.log(`\nUčitano ${rawDocs.length} dokumenata (${ocrCount} preko OCR-a)`);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const docs = enrichMetadata(await splitter.splitDocuments(rawDocs));
  console.log(`Podeljeno u ${docs.length} fragmenata (chunk ${CHUNK_SIZE}/${CHUNK_OVERLAP})`);

  if (docs.length === 0) {
    console.error('Nema fragmenata nakon podele — prekidam.');
    return;
  }

  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: GEMINI_API_KEY,
    model: EMBEDDING_MODEL,
    maxRetries: 5,
    maxConcurrency: 2,
  });

  const pineconeClient = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pineconeClient.Index(PINECONE_INDEX_NAME_OVERRIDE);

  const before = await index.describeIndexStats();
  console.log(`\nIndeks pre upisa: ${before.totalRecordCount ?? 0} vektora`);

  const store = await PineconeStore.fromExistingIndex(embeddings, {
    // TODO: ukloniti `as any` nakon usklađivanja verzija Pinecone paketa.
    pineconeIndex: index as any,
    namespace: PINECONE_NAME_SPACE,
    textKey: 'text',
  });

  await upsertInBatches(store, docs);

  const after = await index.describeIndexStats();
  console.log(`\nIndeks posle upisa: ${after.totalRecordCount ?? 0} vektora`);
  console.log('Ingestija završena.');
}

export const run = runIngestion;

/**
 * Pokreće se samo kada je fajl direktno pozvan iz komandne linije.
 * Ranije je na dnu stajao IIFE koji je kretao pri svakom importu modula.
 */
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runIngestion()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Ingestija neuspešna:', err);
      process.exit(1);
    });
}