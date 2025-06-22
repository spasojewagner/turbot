import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { PineconeStore } from '@langchain/pinecone';
import { Document } from '@langchain/core/documents';
import { DirectoryLoader } from 'langchain/document_loaders/fs/directory';
import { Pinecone } from '@pinecone-database/pinecone';

import { CustomPDFLoader } from '@/utils/customPDFLoader';
import { PINECONE_NAME_SPACE } from '@/config/pinecone';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_INDEX_NAME_OVERRIDE = process.env.PINECONE_INDEX_NAME!;

/** TODO(faza #2): text-embedding-004 je ugašen 14.01.2026. */
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-004';

/** TODO(faza #6): zameniti object storage-om, obrisati docs/ iz repoa. */
const SOURCE_DIR = process.env.INGEST_SOURCE_DIR ?? 'docs';

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const BATCH_SIZE = 2;
const BATCH_DELAY_MS = 5_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministički ID iz putanje dokumenta i sadržaja chunka.
 *
 * ISPRAVKA: ranije je svaki `npm run ingest` upisivao nove vektore sa
 * nasumičnim ID-jevima, pa je ponovno pokretanje množilo isti sadržaj
 * u indeksu. Duplikati zauzimaju mesta u top-k rezultatima i kvare
 * kvalitet odgovora. Sa stabilnim ID-jem upsert prepisuje isti zapis.
 */
function buildChunkId(doc: Document, position: number): string {
  const source =
    typeof doc.metadata?.source === 'string' ? doc.metadata.source : 'unknown';
  const hash = createHash('sha256')
    .update(`${source}::${position}::${doc.pageContent}`)
    .digest('hex');

  return hash.slice(0, 40);
}

function isRateLimitError(message: string): boolean {
  return (
    message.includes('429') ||
    message.includes('Too Many Requests') ||
    message.includes('quota')
  );
}

/** Obogaćuje chunkove metapodacima koji su potrebni za citiranje izvora. */
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

async function upsertInBatches(
  store: PineconeStore,
  docs: Document[],
): Promise<void> {
  const totalBatches = Math.ceil(docs.length / BATCH_SIZE);
  console.log(`Upisujem ${docs.length} fragmenata u ${totalBatches} batch-eva`);

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const ids = batch.map((doc, offset) => buildChunkId(doc, i + offset));

    try {
      await store.addDocuments(batch, { ids });
      console.log(`Batch ${batchNumber}/${totalBatches} upisan`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Greška u batch-u ${batchNumber}: ${message}`);

      if (!isRateLimitError(message)) throw err;

      console.warn(
        `Rate limit — čekam ${RATE_LIMIT_BACKOFF_MS / 1000}s pa pokušavam ponovo`,
      );
      await delay(RATE_LIMIT_BACKOFF_MS);

      await store.addDocuments(batch, { ids });
      console.log(`Batch ${batchNumber}/${totalBatches} upisan iz drugog pokušaja`);
    }

    if (i + BATCH_SIZE < docs.length) {
      await delay(BATCH_DELAY_MS);
    }
  }
}

export async function runIngestion(): Promise<void> {
  console.log(`Učitavam dokumente iz "${SOURCE_DIR}"...`);

  const directoryLoader = new DirectoryLoader(SOURCE_DIR, {
    '.pdf': (path: string) => new CustomPDFLoader(path),
  });

  const rawDocs = await directoryLoader.load();
  console.log(`Učitano ${rawDocs.length} dokumenata`);

  if (rawDocs.length === 0) {
    console.warn('Nema dokumenata za obradu — prekidam.');
    return;
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const splitDocs = await splitter.splitDocuments(rawDocs);
  const docs = enrichMetadata(splitDocs);
  console.log(`Podeljeno u ${docs.length} fragmenata`);

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

  const statsBefore = await index.describeIndexStats();
  console.log('Stanje indeksa pre upisa:', statsBefore);

  // ISPRAVKA: ranije se PineconeStore kreirao iznova za svaki batch.
  // Sada se pravi jednom i ponovo koristi.
  const store = await PineconeStore.fromExistingIndex(embeddings, {
    // TODO(faza #2): ukloniti `as any` nakon usklađivanja verzija.
    pineconeIndex: index as any,
    namespace: PINECONE_NAME_SPACE,
    textKey: 'text',
  });

  await upsertInBatches(store, docs);

  const statsAfter = await index.describeIndexStats();
  console.log('Stanje indeksa posle upisa:', statsAfter);
  console.log('Ingestija završena.');
}

export const run = runIngestion;

/**
 * ISPRAVKA: ranije je na dnu fajla stajao IIFE koji se izvršavao pri
 * svakom importu modula — dovoljno je bilo importovati `runIngestion`
 * i ingestija bi krenula sama. Sada se pokreće samo kada je fajl
 * direktno pozvan iz komandne linije.
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