import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { Document } from '@langchain/core/documents';
import { Pinecone } from '@pinecone-database/pinecone';

import { env } from '@/lib/env';
import { CustomPDFLoader } from '@/utils/customPDFLoader';

const BATCH_SIZE = 2;
const BATCH_DELAY_MS = 12_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RETRIES = 3;

/** Fajl koji proizvodi `npm run ocr` za skenirane PDF-ove. */
const OCR_SUFFIX = '.ocr.txt';

/** Dopunjavanje postojećeg indeksa umesto punjenja praznog. */
const APPEND = process.argv.includes('--append');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pomoćne funkcije
// ---------------------------------------------------------------------------

/**
 * ID fragmenta je heš izvora, pozicije i sadržaja.
 *
 * Zbog toga je ponovljena ingestija idempotentna — isti sadržaj prepisuje
 * isti zapis umesto da pravi duplikat. To ujedno znači da se prekinuta
 * ingestija nastavlja sa `--append` bez posledica.
 */
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

function toTitle(filename: string): string {
  return filename
    .replace(/\.ocr\.txt$/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/\s*\(kliknuti za prikaz\)\s*/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Učitavanje
// ---------------------------------------------------------------------------

/**
 * Učitava jedan PDF, ili njegov OCR prepis ako postoji.
 *
 * Skenirani cenovnici nemaju tekstualni sloj — `pdf-parse` iz njih izvuče
 * po nekoliko znakova. Za njih `npm run ocr` unapred napravi `.ocr.txt`.
 */
async function loadDocument(file: string): Promise<Document[]> {
  const pdfPath = join(env.INGEST_SOURCE_DIR, file);
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

/**
 * Dodaje naziv aranžmana na početak svakog fragmenta.
 *
 * Tabele sa cenama su nizovi brojeva i oznaka ("HOTEL 3*** / 549€") koji
 * semantički ne liče ni na jedno pitanje. Bez ovog zaglavlja takav fragment
 * nikada ne pobedi prozni opis uslova, iako sadrži traženi odgovor.
 */
function enrichDocuments(docs: Document[]): Document[] {
  return docs
    .map((doc, index) => {
      const source =
        typeof doc.metadata?.source === 'string' ? doc.metadata.source : 'unknown';
      const filename = basename(source);
      const title = toTitle(filename);
      const body = doc.pageContent.trim();

      return new Document({
        pageContent: title ? `${title}\n\n${body}` : body,
        metadata: { ...doc.metadata, source, filename, title, chunkIndex: index },
      });
    })
    // Prazan fragment daje prazan vektor, koji Pinecone odbija.
    .filter((doc) => doc.pageContent.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Upis
// ---------------------------------------------------------------------------

/**
 * Vektori se prave preko `embedQuery`, ne `embedDocuments`.
 *
 * Verzija @langchain/google-genai koju koristimo ne parsira odgovor
 * `batchEmbedContents` endpointa za gemini-embedding-001 — vraća prazne
 * nizove bez ikakve greške, pa Pinecone dobija vektor dimenzije nula.
 */
async function embedBatch(
  embeddings: GoogleGenerativeAIEmbeddings,
  batch: Document[],
): Promise<number[][]> {
  const vectors = await Promise.all(
    batch.map((doc) => embeddings.embedQuery(doc.pageContent)),
  );

  const prazni = vectors.filter((v) => !Array.isArray(v) || v.length === 0).length;
  if (prazni > 0) {
    throw new Error(`Embedding je vratio ${prazni} praznih vektora`);
  }

  return vectors;
}

async function upsertInBatches(
  index: ReturnType<Pinecone['Index']>,
  embeddings: GoogleGenerativeAIEmbeddings,
  docs: Document[],
): Promise<void> {
  const totalBatches = Math.ceil(docs.length / BATCH_SIZE);
  console.log(`\nUpisujem ${docs.length} fragmenata u ${totalBatches} batch-eva`);

  const namespace = index.namespace(env.PINECONE_NAMESPACE);

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

    let attempt = 0;

    while (true) {
      try {
        const vectors = await embedBatch(embeddings, batch);

        await namespace.upsert(
          batch.map((doc, offset) => ({
            id: buildChunkId(doc, i + offset),
            values: vectors[offset],
            metadata: {
              // Ključ mora biti `text` — chat.ts čita sa textKey: 'text'.
              text: doc.pageContent,
              source: String(doc.metadata.source ?? ''),
              filename: String(doc.metadata.filename ?? ''),
              title: String(doc.metadata.title ?? ''),
              extraction: String(doc.metadata.extraction ?? 'pdf'),
            },
          })),
        );

        console.log(`  batch ${batchNumber}/${totalBatches}`);
        break;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        attempt += 1;

        if (!isRateLimitError(message) || attempt > MAX_RETRIES) {
          console.error(`  batch ${batchNumber} neuspešan: ${message}`);
          throw err;
        }

        console.warn(
          `  batch ${batchNumber} — rate limit, čekam ${RATE_LIMIT_BACKOFF_MS / 1000}s ` +
            `(pokušaj ${attempt}/${MAX_RETRIES})`,
        );
        await delay(RATE_LIMIT_BACKOFF_MS);
      }
    }

    if (i + BATCH_SIZE < docs.length) await delay(BATCH_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Glavni tok
// ---------------------------------------------------------------------------

export async function runIngestion(): Promise<void> {
  const files = readdirSync(env.INGEST_SOURCE_DIR).filter((f) =>
    f.toLowerCase().endsWith('.pdf'),
  );

  console.log(`Učitavam ${files.length} dokumenata iz "${env.INGEST_SOURCE_DIR}"...\n`);

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
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
  });

  const docs = enrichDocuments(await splitter.splitDocuments(rawDocs));
  console.log(
    `Podeljeno u ${docs.length} fragmenata (chunk ${env.CHUNK_SIZE}/${env.CHUNK_OVERLAP})`,
  );

  if (docs.length === 0) {
    console.error('Nema fragmenata nakon podele — prekidam.');
    return;
  }

  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: env.GEMINI_API_KEY,
    model: env.EMBEDDING_MODEL,
    maxRetries: 5,
    maxConcurrency: 2,
  });

  const pineconeClient = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  const index = pineconeClient.Index(env.PINECONE_INDEX_NAME);

  const before = await index.describeIndexStats();
  const existing = before.totalRecordCount ?? 0;

  console.log(`\nIndeks pre upisa: ${existing} vektora`);

  /**
   * Zaštita od tihih duplikata.
   *
   * ID fragmenta je heš njegovog sadržaja. Ako se promeni chunkovanje ili
   * način obrade teksta, novi fragmenti neće prepisati stare nego će se
   * dodati pored njih — i indeks tiho dobije dve verzije istog dokumenta.
   */
  if (existing > 0 && !APPEND) {
    console.error(
      '\nIndeks nije prazan. Ingestija bi napravila duplikate ako se chunkovanje\n' +
        'ili obrada teksta promenila od poslednjeg puta.\n\n' +
        'Obriši indeks u Pinecone konzoli i napravi nov, ili pokreni sa --append\n' +
        'ako namerno dopunjavaš postojeći sadržaj.',
    );
    process.exit(1);
  }

  await upsertInBatches(index, embeddings, docs);

  const after = await index.describeIndexStats();
  console.log(`\nIndeks posle upisa: ${after.totalRecordCount ?? 0} vektora`);
  console.log('Ingestija završena.');
}

export const run = runIngestion;

/** Pokreće se samo kada je fajl direktno pozvan iz komandne linije. */
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