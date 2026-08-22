import { z } from 'zod';

/**
 * Jedan izvor istine za konfiguraciju, validiran pri učitavanju modula.
 *
 * SAMO ZA SERVER. Ne uvoziti u komponente — sadrži tajne.
 */

export const envSchema = z.object({
  // --- tajne ---
  GEMINI_API_KEY: z.string().min(1, 'Ključ iz Google AI Studio'),
  PINECONE_API_KEY: z.string().min(1, 'Ključ iz Pinecone konzole'),

  /**
   * Token za Vercel Blob. Na Vercelu se ubacuje sam kada se napravi Blob
   * store; lokalno se dobija sa `vercel env pull`.
   *
   * Opcion je namerno: aplikacija radi i bez njega, samo bez upravljanja
   * dokumentima. Rute pod /api/documents tada vraćaju jasnu grešku.
   */
  BLOB_READ_WRITE_TOKEN: z.string().optional(),

  /**
   * Lozinka za stranicu sa dokumentima.
   *
   * Nije prava autentifikacija, nego jedan deljeni token za jednog
   * administratora. Za više korisnika treba sistem naloga.
   */
  ADMIN_TOKEN: z.string().optional(),

  // --- vektorska baza ---
  PINECONE_INDEX_NAME: z.string().min(1, 'Naziv indeksa, npr. turbot-3072'),
  PINECONE_NAMESPACE: z.string().default('pdf-chatbot'),

  // --- modeli ---
  CHAT_MODEL: z.string().default('gemini-3.6-flash'),
  UTILITY_MODEL: z.string().default('gemini-3.1-flash-lite'),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  OCR_MODEL: z.string().optional(),

  // --- pretraga ---
  RETRIEVAL_K: z.coerce.number().int().positive().default(12),
  RELEVANCE_FLOOR: z.coerce.number().min(0).max(1).default(0.62),

  // --- ingestija ---
  CHUNK_SIZE: z.coerce.number().int().positive().default(1400),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(250),
  /** Rezervni izvor dokumenata kada Blob nije podešen. */
  INGEST_SOURCE_DIR: z.string().default('docs'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);

  return [
    '',
    'Konfiguracija nije ispravna:',
    '',
    ...lines,
    '',
    'Proveri .env.local u korenu projekta. Uzor je .env.example.',
    '',
  ].join('\n');
}

function load(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error(formatIssues(result.error));
    throw new Error('Neispravna konfiguracija okruženja');
  }

  return result.data;
}

export const env = load();

/** OCR koristi glavni model osim ako nije zadat poseban. */
export const OCR_MODEL = env.OCR_MODEL ?? env.CHAT_MODEL;

/** Da li je upravljanje dokumentima moguće u ovom okruženju. */
export const blobEnabled = Boolean(env.BLOB_READ_WRITE_TOKEN);