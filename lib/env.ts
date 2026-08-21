import { z } from 'zod';

/**
 * Jedan izvor istine za konfiguraciju.
 *
 * Ranije su env varijable čitane na četiri mesta — `config/pinecone.ts`,
 * `utils/pinecone-client.ts`, `pages/api/chat.ts` i `scripts/ingest-data.ts` —
 * pri čemu su poslednja dva zaobilazila prva dva hardkodovanim vrednostima.
 * Tri izvora istine za istu stvar znače da se pre ili kasnije raziđu.
 *
 * Validacija se izvršava pri učitavanju modula, pa aplikacija pada odmah i
 * sa jasnom porukom, umesto na prvom API pozivu sa `undefined` ključem.
 *
 * SAMO ZA SERVER. Ne uvoziti u komponente — sadrži tajne.
 */

export const envSchema = z.object({
  // --- tajne ---
  GEMINI_API_KEY: z.string().min(1, 'Ključ iz Google AI Studio'),
  PINECONE_API_KEY: z.string().min(1, 'Ključ iz Pinecone konzole'),

  // --- vektorska baza ---
  PINECONE_INDEX_NAME: z.string().min(1, 'Naziv indeksa, npr. turbot-3072'),
  PINECONE_NAMESPACE: z.string().default('pdf-chatbot'),

  // --- modeli ---
  /** Glavni model. Tabelarni cenovnici traže jaču varijantu. */
  CHAT_MODEL: z.string().default('gemini-3.6-flash'),
  /** Ruter i sažimanje — brzina je bitnija od kvaliteta. */
  UTILITY_MODEL: z.string().default('gemini-3.1-flash-lite'),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  /** Čitanje skeniranih PDF-ova. Podrazumevano isti kao glavni. */
  OCR_MODEL: z.string().optional(),

  // --- pretraga ---
  /** Koliko fragmenata dohvatiti pre filtriranja. */
  RETRIEVAL_K: z.coerce.number().int().positive().default(12),
  /**
   * Prag kosinusne sličnosti.
   * Izmereno na ovom korpusu: dobri pogoci su 0.73–0.78.
   */
  RELEVANCE_FLOOR: z.coerce.number().min(0).max(1).default(0.62),

  // --- ingestija ---
  /**
   * Manje od 1400 seče tabele sa cenama tako da cena završi u jednom
   * fragmentu, a naziv hotela i termin u drugom.
   */
  CHUNK_SIZE: z.coerce.number().int().positive().default(1400),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(250),
  INGEST_SOURCE_DIR: z.string().default('docs'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

/** Čitljiva poruka umesto zod stack trace-a. */
function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join('.');
    return `  ${key}: ${issue.message}`;
  });

  return [
    '',
    'Konfiguracija nije ispravna:',
    '',
    ...lines,
    '',
    'Proveri .env.local u korenu projekta. Uzor je .env.example.',
    'Za skripte, dotenv mora pokazivati na taj fajl:',
    '  tsx -r dotenv/config scripts/... dotenv_config_path=.env.local',
    '',
  ].join('\n');
}

function load(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error(formatIssues(result.error));
    // Padamo odmah — rad sa polovičnom konfiguracijom daje greške koje
    // izgledaju kao problem sa modelom ili bazom, a nisu.
    throw new Error('Neispravna konfiguracija okruženja');
  }

  return result.data;
}

export const env = load();

/** OCR koristi glavni model osim ako nije zadat poseban. */
export const OCR_MODEL = env.OCR_MODEL ?? env.CHAT_MODEL;
