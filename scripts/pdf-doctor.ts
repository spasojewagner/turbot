/**
 * Dijagnostika ekstrakcije teksta iz PDF-a.
 *
 * Pokretanje:
 *   npm run pdf-doctor
 *
 * Ne troši API kvotu — radi isključivo lokalno.
 *
 * Odgovara na tri pitanja:
 *   1. koji fajlovi uopšte ne mogu da se pročitaju
 *   2. koji se pročitaju ali daju premalo teksta (verovatno skenirane slike)
 *   3. koliko je tekst izlomljen ("Ri m avi on" umesto "Rim avion")
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// pdf-parse nema ESM izvoz, pa ide preko createRequire
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const SOURCE_DIR = process.env.INGEST_SOURCE_DIR ?? 'docs';

/** Ispod ovoliko znakova po strani smatramo da ekstrakcija nije uspela. */
const MIN_CHARS_PER_PAGE = 200;

interface Report {
  file: string;
  status: 'ok' | 'sumnjivo' | 'pao';
  pages: number;
  chars: number;
  charsPerPage: number;
  brokenRatio: number;
  controlChars: number;
  sample: string;
  error?: string;
}

/**
 * Udeo osumnjičenih fragmenata reči.
 *
 * Kada pdf-parse pogrešno proceni gde je razmak, reči se cepaju na komade
 * od jednog do dva slova: "Ri m avi on s ezona". Merimo koliko tokena ima
 * dužinu 1–2 a nije prava kratka reč srpskog jezika.
 */
const PRAVE_KRATKE_RECI = new Set([
  'a', 'i', 'u', 'o', 's', 'k', 'do', 'od', 'za', 'na', 'po', 'sa', 'je', 'su',
  'se', 'ne', 'da', 'li', 'ka', 'iz', 'uz', 'te', 'to', 'ti', 'mi', 'me', 'my',
  'ih', 'im', 'ga', 'go', 'br', 'st', 'in', 'of', 'no', 'ii', 'iv', 'ix', 'xi',
]);

function measureBrokenness(text: string): number {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => /^[a-zčćžšđ]+$/i.test(t));

  if (tokens.length < 50) return 0;

  const suspicious = tokens.filter(
    (t) => t.length <= 2 && !PRAVE_KRATKE_RECI.has(t),
  ).length;

  return suspicious / tokens.length;
}

function countControlChars(text: string): number {
  // Neprepoznati glifovi (bullet znakovi i slično) koje pdf-parse ne mapira.
  const matches = text.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
  return matches ? matches.length : 0;
}

async function inspect(file: string): Promise<Report> {
  const path = join(SOURCE_DIR, file);

  try {
    const buffer = readFileSync(path);
    const parsed = await pdfParse(buffer);

    const text = parsed.text ?? '';
    const pages = parsed.numpages ?? 0;
    const chars = text.trim().length;
    const charsPerPage = pages > 0 ? Math.round(chars / pages) : 0;
    const brokenRatio = measureBrokenness(text);

    return {
      file,
      status: charsPerPage < MIN_CHARS_PER_PAGE ? 'sumnjivo' : 'ok',
      pages,
      chars,
      charsPerPage,
      brokenRatio,
      controlChars: countControlChars(text),
      sample: text.replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  } catch (err) {
    return {
      file,
      status: 'pao',
      pages: 0,
      chars: 0,
      charsPerPage: 0,
      brokenRatio: 0,
      controlChars: 0,
      sample: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------

const files = readdirSync(SOURCE_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));

console.log(`Pronađeno ${files.length} PDF fajlova u "${SOURCE_DIR}"\n`);

const reports: Report[] = [];
for (const file of files) {
  reports.push(await inspect(file));
}

const pali = reports.filter((r) => r.status === 'pao');
const sumnjivi = reports.filter((r) => r.status === 'sumnjivo');
const ok = reports.filter((r) => r.status === 'ok');

// ---------------------------------------------------------------------------

if (pali.length > 0) {
  console.log('='.repeat(70));
  console.log(`NE MOGU DA SE PROČITAJU (${pali.length})`);
  console.log('='.repeat(70));
  for (const r of pali) {
    console.log(`\n  ${r.file}`);
    console.log(`    ${r.error}`);
  }
  console.log();
}

if (sumnjivi.length > 0) {
  console.log('='.repeat(70));
  console.log(`PREMALO TEKSTA — verovatno skenirane slike (${sumnjivi.length})`);
  console.log('='.repeat(70));
  for (const r of sumnjivi) {
    console.log(`\n  ${r.file}`);
    console.log(`    ${r.pages} strana, ${r.chars} znakova (${r.charsPerPage}/strani)`);
    if (r.sample) console.log(`    "${r.sample}"`);
  }
  console.log();
}

console.log('='.repeat(70));
console.log(`PROČITANI (${ok.length}) — sortirano po izlomljenosti teksta`);
console.log('='.repeat(70));
console.log();

const sorted = [...ok].sort((a, b) => b.brokenRatio - a.brokenRatio);

for (const r of sorted) {
  const pct = (r.brokenRatio * 100).toFixed(1);
  const flag = r.brokenRatio > 0.12 ? ' <-- LOŠE' : r.brokenRatio > 0.06 ? ' <-- osrednje' : '';
  const ctrl = r.controlChars > 0 ? `, ${r.controlChars} neprepoznatih znakova` : '';

  console.log(`  ${pct.padStart(5)}%  ${r.file}${flag}`);
  console.log(`         ${r.pages} str, ${r.charsPerPage} znakova/str${ctrl}`);
}

// ---------------------------------------------------------------------------

const avgBroken = ok.reduce((sum, r) => sum + r.brokenRatio, 0) / (ok.length || 1);
const totalChars = ok.reduce((sum, r) => sum + r.chars, 0);
const totalControl = ok.reduce((sum, r) => sum + r.controlChars, 0);

console.log();
console.log('='.repeat(70));
console.log('ZBIRNO');
console.log('='.repeat(70));
console.log(`  ukupno fajlova:        ${files.length}`);
console.log(`  pročitano:             ${ok.length}`);
console.log(`  premalo teksta:        ${sumnjivi.length}`);
console.log(`  palo:                  ${pali.length}`);
console.log(`  ukupno znakova:        ${totalChars.toLocaleString('sr-RS')}`);
console.log(`  prosečna izlomljenost: ${(avgBroken * 100).toFixed(1)}%`);
console.log(`  neprepoznatih znakova: ${totalControl}`);
console.log();
console.log('  Izlomljenost preko 12% znači da pretraga ozbiljno gubi na tačnosti —');
console.log('  u indeksu stoji "Ri m avi on" umesto "Rim avion".');