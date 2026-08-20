/**
 * Čitanje skeniranih PDF-ova preko Gemini modela.
 *
 * Pokretanje:
 *   npm run ocr             # samo fajlovi bez keša
 *   npm run ocr -- --force  # ponovo sve
 *
 * Neki cenovnici su skenirane slike bez tekstualnog sloja — `pdf-doctor` ih
 * prijavljuje kao "premalo teksta". Gemini prima PDF kao ulaz i sam čita
 * sadržaj, pa nema renderovanja stranica u slike: nema pdfjs-a, canvas
 * backenda, ImageMagicka ni Ghostscripta.
 *
 * Rezultat se snima kao `<ime>.ocr.txt` pored PDF-a, pa se plaća jednom.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { GoogleGenerativeAI } from '@google/generative-ai';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const OCR_MODEL = process.env.OCR_MODEL ?? process.env.CHAT_MODEL ?? 'gemini-3.6-flash';
const SOURCE_DIR = process.env.INGEST_SOURCE_DIR ?? 'docs';

/** Ispod ovoliko znakova po strani smatramo da tekstualnog sloja nema. */
const MIN_CHARS_PER_PAGE = 200;
/** Granica za slanje u telu zahteva. Veći fajlovi traže Files API. */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;
const DELAY_MS = 4000;

export const OCR_SUFFIX = '.ocr.txt';

const force = process.argv.includes('--force');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT = `Izvuci strukturirane podatke iz ovog skeniranog cenovnika turističke agencije na srpskom jeziku.

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
- Ako podatak ne postoji u dokumentu, preskoči tu stavku bez komentara.
- Ako je nešto nečitko, napiši [nečitko].`;

// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: OCR_MODEL });

async function ocrFile(file: string): Promise<boolean> {
  const pdfPath = join(SOURCE_DIR, file);
  const outPath = pdfPath.replace(/\.pdf$/i, OCR_SUFFIX);

  if (existsSync(outPath) && !force) {
    console.log('  preskačem, keš postoji');
    return true;
  }

  const size = statSync(pdfPath).size;

  if (size > MAX_INLINE_BYTES) {
    console.warn(`  fajl je prevelik za slanje u telu zahteva (${Math.round(size / 1024 / 1024)} MB)`);
    return false;
  }

  console.log(`  šaljem ${Math.round(size / 1024)} KB modelu ${OCR_MODEL}...`);

  const result = await model.generateContent([
    { text: PROMPT },
    {
      inlineData: {
        mimeType: 'application/pdf',
        data: readFileSync(pdfPath).toString('base64'),
      },
    },
  ]);

  const text = result.response.text().trim();

  if (text.length < 100) {
    console.warn(`  model vratio premalo teksta (${text.length} znakova)`);
    return false;
  }

  writeFileSync(outPath, text, 'utf8');
  console.log(`  snimljeno ${text.length} znakova -> ${file.replace(/\.pdf$/i, OCR_SUFFIX)}`);
  return true;
}

// ---------------------------------------------------------------------------

const files = readdirSync(SOURCE_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));

console.log(`Tražim skenirane PDF-ove među ${files.length} fajlova...\n`);

const kandidati: string[] = [];

for (const file of files) {
  try {
    const parsed = await pdfParse(readFileSync(join(SOURCE_DIR, file)));
    const pages = parsed.numpages ?? 1;
    const perPage = Math.round((parsed.text?.trim().length ?? 0) / pages);

    if (perPage < MIN_CHARS_PER_PAGE) {
      kandidati.push(file);
      console.log(`  ${file} — ${perPage} znakova/strani`);
    }
  } catch {
    kandidati.push(file);
    console.log(`  ${file} — ne može da se pročita`);
  }
}

if (kandidati.length === 0) {
  console.log('\nNema skeniranih PDF-ova.');
  process.exit(0);
}

console.log(`\nPronađeno ${kandidati.length} kandidata.\n`);

let uspesno = 0;

for (const [i, file] of kandidati.entries()) {
  console.log(`[${i + 1}/${kandidati.length}] ${file}`);

  try {
    if (await ocrFile(file)) uspesno += 1;
  } catch (err) {
    console.error(`  GREŠKA: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (i < kandidati.length - 1) await delay(DELAY_MS);
}

console.log(`\nGotovo. Obrađeno ${uspesno}/${kandidati.length}.`);

if (uspesno > 0) {
  console.log('Proveri sadržaj .ocr.txt fajlova, pa pokreni `npm run ingest`.');
}