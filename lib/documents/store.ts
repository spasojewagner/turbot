import { createHash } from 'node:crypto';
import { del, list, put } from '@vercel/blob';

import { env } from '@/lib/env';

/**
 * Registar dokumenata.
 *
 * Fajlovi žive u Vercel Blob-u, a stanje ingestije u jednom JSON manifestu
 * pored njih. Namerno bez baze: pri tridesetak dokumenata i jednom
 * administratoru, Postgres bi bio infrastruktura koja rešava problem koji
 * ne postoji.
 *
 * Granica na kojoj to prestaje da važi: više administratora koji pišu
 * istovremeno, ili nekoliko stotina dokumenata.
 */

const MANIFEST_PATH = 'documents/manifest.json';
const DOCS_PREFIX = 'documents/files/';
const TEXT_PREFIX = 'documents/text/';

/**
 * Način pristupa mora da odgovara podešavanju samog store-a.
 * Vercel odbija upis sa `public` u privatan store i obrnuto.
 */
const ACCESS: 'public' | 'private' =
  process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface DocumentRecord {
  id: string;
  filename: string;
  url: string;
  pathname: string;
  size: number;
  /** sha256 sadržaja. Sprečava dvostruko dodavanje istog fajla. */
  checksum: string;
  uploadedAt: string;
  status: DocumentStatus;
  /** Poreklo teksta: tekstualni sloj PDF-a ili prepis modelom. */
  extraction?: 'pdf' | 'ocr';

  /**
   * Napredak ingestije.
   *
   * Veliki cenovnici ne stanu u jedan poziv — serverless funkcija ima gornju
   * granicu trajanja. Zato se obrada deli na više prolaza, a ovde stoji
   * dokle se stiglo.
   */
  chunkTotal?: number;
  chunkDone?: number;
  chunkCount?: number;

  /**
   * ID-jevi fragmenata u Pineconeu.
   *
   * Čuvaju se da bi brisanje dokumenta moglo da ukloni i njegove vektore.
   * Brisanje po metapodacima nije podržano na svim Pinecone nivoima, a
   * brisanje po listi ID-jeva radi svuda.
   */
  chunkIds?: string[];
  error?: string;
}

interface Manifest {
  version: 1;
  updatedAt: string;
  documents: DocumentRecord[];
}

const EMPTY: Manifest = { version: 1, updatedAt: '', documents: [] };

function assertEnabled(): void {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN nije podešen. Napravi Blob store u Vercel ' +
        'konzoli, pa pokreni `vercel env pull` da povučeš token lokalno.',
    );
  }
}

/**
 * Token se prosleđuje eksplicitno pri svakom pozivu.
 *
 * Bez toga `@vercel/blob` pokušava OIDC autentifikaciju kada zatekne
 * `VERCEL_OIDC_TOKEN` u okruženju, a taj token ne važi za `development`.
 */
const blobOptions = () => ({ token: env.BLOB_READ_WRITE_TOKEN });

/**
 * Privatni store ne servira fajlove javno, pa URL sam po sebi nije dovoljan.
 * Token ide kao Bearer zaglavlje; kod javnog store-a je bezopasan.
 */
async function fetchBlob(url: string): Promise<Response> {
  return fetch(url, {
    // Bez ovoga bi se čitalo zastarelo stanje sa CDN-a odmah posle upisa.
    cache: 'no-store',
    headers: { Authorization: `Bearer ${env.BLOB_READ_WRITE_TOKEN}` },
  });
}

export function checksumOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export async function readManifest(): Promise<Manifest> {
  assertEnabled();

  const { blobs } = await list({ prefix: MANIFEST_PATH, limit: 1, ...blobOptions() });
  if (blobs.length === 0) return { ...EMPTY, documents: [] };

  try {
    const response = await fetchBlob(blobs[0].url);
    const parsed = (await response.json()) as Manifest;

    return Array.isArray(parsed?.documents) ? parsed : { ...EMPTY, documents: [] };
  } catch {
    console.warn('[documents] manifest se ne može pročitati, koristim prazan');
    return { ...EMPTY, documents: [] };
  }
}

async function writeManifest(documents: DocumentRecord[]): Promise<void> {
  assertEnabled();

  const manifest: Manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    documents,
  };

  await put(MANIFEST_PATH, JSON.stringify(manifest, null, 2), {
    access: ACCESS,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    ...blobOptions(),
  });
}

/**
 * Izmena jednog zapisa. Poslednji upis pobeđuje, što je uz jednog
 * administratora prihvatljivo.
 */
export async function updateDocument(
  id: string,
  patch: Partial<DocumentRecord>,
): Promise<DocumentRecord | null> {
  const { documents } = await readManifest();
  const index = documents.findIndex((d) => d.id === id);

  if (index === -1) return null;

  documents[index] = { ...documents[index], ...patch };
  await writeManifest(documents);

  return documents[index];
}

// ---------------------------------------------------------------------------
// Operacije nad dokumentima
// ---------------------------------------------------------------------------

export async function listDocuments(): Promise<DocumentRecord[]> {
  const { documents } = await readManifest();

  return [...documents].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function findDocument(id: string): Promise<DocumentRecord | null> {
  const { documents } = await readManifest();
  return documents.find((d) => d.id === id) ?? null;
}

export interface UploadResult {
  document: DocumentRecord;
  duplicate: boolean;
}

export async function uploadDocument(
  filename: string,
  buffer: Buffer,
): Promise<UploadResult> {
  assertEnabled();

  const checksum = checksumOf(buffer);
  const { documents } = await readManifest();

  // Isti sadržaj pod drugim imenom i dalje je isti dokument.
  const existing = documents.find((d) => d.checksum === checksum);
  if (existing) return { document: existing, duplicate: true };

  const id = checksum.slice(0, 16);
  const safeName = filename.replace(/[^\w.\- ()]/g, '_');

  const blob = await put(`${DOCS_PREFIX}${id}-${safeName}`, buffer, {
    access: ACCESS,
    contentType: 'application/pdf',
    addRandomSuffix: false,
    allowOverwrite: true,
    ...blobOptions(),
  });

  const record: DocumentRecord = {
    id,
    filename,
    url: blob.url,
    pathname: blob.pathname,
    size: buffer.byteLength,
    checksum,
    uploadedAt: new Date().toISOString(),
    status: 'pending',
  };

  await writeManifest([...documents, record]);
  return { document: record, duplicate: false };
}

export async function removeDocument(id: string): Promise<DocumentRecord | null> {
  assertEnabled();

  const { documents } = await readManifest();
  const record = documents.find((d) => d.id === id);
  if (!record) return null;

  // Greške pri brisanju se ne propagiraju — zapis mora da nestane iz
  // manifesta i ako je fajl već obrisan.
  await Promise.allSettled([
    del(record.pathname, blobOptions()),
    del(`${TEXT_PREFIX}${id}.txt`, blobOptions()),
  ]);

  await writeManifest(documents.filter((d) => d.id !== id));
  return record;
}

// ---------------------------------------------------------------------------
// Keš izvučenog teksta
// ---------------------------------------------------------------------------

/**
 * Izvučen tekst se čuva iz dva razloga.
 *
 * Kod skeniranih cenovnika je to rezultat plaćenog poziva modelu, pa se ne
 * plaća dvaput. Kod svih ostalih omogućava da se prekinuta ingestija nastavi
 * bez ponovnog preuzimanja i parsiranja PDF-a.
 */
export async function readCachedText(id: string): Promise<string | null> {
  assertEnabled();

  const { blobs } = await list({
    prefix: `${TEXT_PREFIX}${id}.txt`,
    limit: 1,
    ...blobOptions(),
  });
  if (blobs.length === 0) return null;

  try {
    const response = await fetchBlob(blobs[0].url);
    const text = await response.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function writeCachedText(id: string, text: string): Promise<void> {
  assertEnabled();

  await put(`${TEXT_PREFIX}${id}.txt`, text, {
    access: ACCESS,
    contentType: 'text/plain; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
    ...blobOptions(),
  });
}

export async function fetchDocumentBuffer(record: DocumentRecord): Promise<Buffer> {
  const response = await fetchBlob(record.url);

  if (!response.ok) {
    throw new Error(`Fajl se ne može preuzeti (HTTP ${response.status})`);
  }

  return Buffer.from(await response.arrayBuffer());
}