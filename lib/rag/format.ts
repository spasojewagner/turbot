import { Document } from '@langchain/core/documents';

/**
 * Čiste funkcije RAG sloja.
 *
 * Sve ovde je bez mrežnih poziva i bez stanja, pa se pokriva jediničnim
 * testovima bez ijednog poziva ka modelu.
 */

export type Intent = 'cenovnik' | 'nastavak' | 'razgovor' | 'van_teme';

export const VALID_INTENTS: Intent[] = ['cenovnik', 'nastavak', 'razgovor', 'van_teme'];

export interface SourceRef {
  label: string;
  filename: string;
  excerpt: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Metapodaci
// ---------------------------------------------------------------------------

export function getFilename(doc: Document): string {
  const meta = doc.metadata ?? {};
  if (typeof meta.filename === 'string') return meta.filename;
  if (typeof meta.source === 'string') {
    return meta.source.split(/[\\/]/).pop() ?? 'nepoznat izvor';
  }
  return 'nepoznat izvor';
}

export function toLabel(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/\s*\(kliknuti za prikaz\)\s*/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Istorija
// ---------------------------------------------------------------------------

export function renderTurns(turns: [string, string][], maxChars = 700): string {
  return turns
    .map(
      ([human, ai]) =>
        `Korisnik: ${human.slice(0, maxChars)}\nAsistent: ${ai.slice(0, maxChars)}`,
    )
    .join('\n\n');
}

export function normalizeHistory(input: unknown, maxTurns = 12): [string, string][] {
  if (!Array.isArray(input)) return [];

  return input
    .filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string',
    )
    .slice(-maxTurns);
}

// ---------------------------------------------------------------------------
// Prepoznavanje pojmova
//
// Alternative su namerno prefiksi ("termin", "hotel", "malt") i zato NEMA
// zatvarajuće granice reči — sa `\b` na kraju bi "termini", "hotela" i
// "Maltu" prestali da se poklapaju.
// ---------------------------------------------------------------------------

const POZDRAVI =
  /^(zdravo|ćao|cao|hej|hi|hello|dobar dan|dobro jutro|dobro veče|dobro vece|hvala|pozdrav|važi|vazi|ok|okej|super)\b/i;

/** Oblici opšteg znanja — pominju pojam, ali nemaju veze sa cenovnikom. */
const OPSTE_ZNANJE =
  /^(ko je|ko su|šta je|sta je|šta znači|sta znaci|gde se nalazi|kada je|zašto|zasto|koliko ima stanovnika|koji je glavni grad)/i;

const PUTOVANJE =
  /\b(cen[aeiu]|košta|kosta|aranžman|aranzman|termin|polaz|povrat|noćenj|nocenj|noći|noci|hotel|smeštaj|smestaj|avion|autobus|putovanj|ponud|doručak|dorucak|doplat|popust|taks|izlet|destinacij|rezervacij|osiguranj|prtljag|transfer|vodič|vodic|apartman|pansion)/i;

const DESTINACIJE_IZVOR =
  'rim|istanbul|malt|maroko|lisabon|porto|portugal|amsterdam|peterburg|bari|pulj|kairo|andaluzij|malag|škotsk|skotsk|englesk|francusk|pariz|ljubljan|švajcarsk|svajcarsk|ženev|zenev|bern|cirih|barselon|monako|milano|minhen|salcburg|trst|padov|španij|spanij|italij|grčk|grck|tursk|egipat|holandij|rusij|slovenij|koimbr|brag|sintr';

const DESTINACIJE = new RegExp(`\\b(${DESTINACIJE_IZVOR})`, 'i');
/** Ista lista sa globalnom zastavicom — za brojanje pogodaka. */
const DESTINACIJE_SVE = new RegExp(`\\b(${DESTINACIJE_IZVOR})`, 'gi');

// ---------------------------------------------------------------------------
// Rerankiranje
// ---------------------------------------------------------------------------

/** Pitanje traži cenu. */
const PITA_CENU = /\b(cen[aeiu]|košta|kosta|koliko|evra|eura|€|budžet|budzet|jeftin|skup|plati|uplat|rat[ae])/i;
/** Pitanje traži termin ili datum. */
const PITA_TERMIN =
  /\b(termin|datum|polaz|povrat|kada|kad\b|kalendar|maj|april|jun|jul|avgust|septembar|oktobar|novembar|decembar|noćenj|nocenj|dana|dan[ae])/i;
/** Pitanje traži šta je uključeno. */
const PITA_SADRZAJ = /\b(uključ|ukljuc|sadrž|sadrz|obuhvat|dobij|servis|usluг|usluž|uslug)/i;

/** Fragment sadrži iznos u evrima. */
const IMA_CENU = /\d{2,5}\s*(€|eur\b|evr|eura)/i;
/** Fragment sadrži datum. */
const IMA_DATUM =
  /\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4}|\d{1,2}\.\s*(januar|februar|mart|april|maj|jun|jul|avgust|septembar|oktobar|novembar|decembar)/i;
/** Fragment nabraja šta je uključeno. */
const IMA_SADRZAJ = /\b(u cenu je uključen|u cenu je ukljucen|uključeno u cenu|ukljuceno u cenu|cena obuhvata|aranžman obuhvata)/i;

/** Koliko se skor podiže po pogođenom signalu. */
const BOOST = 0.06;

export interface RerankedEntry {
  doc: Document;
  /** Skor iz vektorske pretrage. */
  vectorScore: number;
  /** Skor posle leksičkih dodataka — po njemu se sortira. */
  finalScore: number;
  /** Koji signali su pogodili, za dijagnostiku. */
  signals: string[];
}

/**
 * Preuređuje rezultate pretrage kombinujući vektorsku sličnost sa leksičkim
 * signalima.
 *
 * Razlog je izmeren: fragment sa tabelom cena je niz brojeva i oznaka
 * ("HOTEL 3*** / 549€"), pa semantički slabo liči na rečenicu "koliko košta
 * Rim avionom". Prozni opisi uslova ga redovno pobeđuju u sličnosti, iako
 * odgovor sadrži samo tabela.
 *
 * Posledica je bila da isto pitanje u dve formulacije daje različit rezultat —
 * "koliko košta" je nalazilo cenu, "koje ponude imate" nije.
 *
 * Dodatak je namerno mali (0.06 po signalu) da vektorska sličnost ostane
 * glavni kriterijum, a leksički signali samo razrešavaju bliske slučajeve.
 * Bez poziva modelu, dakle bez latencije i bez troška.
 */
export function rerank(
  question: string,
  scored: [Document, number][],
): RerankedEntry[] {
  const traziCenu = PITA_CENU.test(question);
  const traziTermin = PITA_TERMIN.test(question);
  const traziSadrzaj = PITA_SADRZAJ.test(question);

  const entries: RerankedEntry[] = scored.map(([doc, vectorScore]) => {
    const text = doc.pageContent;
    const signals: string[] = [];
    let boost = 0;

    if (traziCenu && IMA_CENU.test(text)) {
      boost += BOOST;
      signals.push('cena');
    }

    if (traziTermin && IMA_DATUM.test(text)) {
      boost += BOOST;
      signals.push('datum');
    }

    if (traziSadrzaj && IMA_SADRZAJ.test(text)) {
      boost += BOOST;
      signals.push('sadrzaj');
    }

    return { doc, vectorScore, finalScore: vectorScore + boost, signals };
  });

  // Stabilno sortiranje: pri jednakom skoru zadržava se redosled pretrage.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      b.entry.finalScore === a.entry.finalScore
        ? a.index - b.index
        : b.entry.finalScore - a.entry.finalScore,
    )
    .map(({ entry }) => entry);
}

// ---------------------------------------------------------------------------
// Rezultati pretrage
// ---------------------------------------------------------------------------

/**
 * Ograničava broj fragmenata po dokumentu, čuvajući redosled po skoru.
 *
 * Bez ovoga pitanje o jednoj destinaciji vrati osam komada istog PDF-a, pa
 * pitanja tipa "aranžmani do 700 €" nikad ne vide više ponuda odjednom.
 */
export function diversify(
  entries: RerankedEntry[],
  maxPerDocument = 2,
): RerankedEntry[] {
  const perDocument = new Map<string, number>();
  const kept: RerankedEntry[] = [];

  for (const entry of entries) {
    const filename = getFilename(entry.doc);
    const used = perDocument.get(filename) ?? 0;
    if (used >= maxPerDocument) continue;

    perDocument.set(filename, used + 1);
    kept.push(entry);
  }

  return kept;
}

/**
 * Koliko fragmenata po dokumentu propustiti.
 *
 * Pitanje o jednoj destinaciji traži dubinu — tabela sa cenama, termini i
 * uslovi su u istom fajlu, često raštrkani kroz nekoliko fragmenata.
 * Široko pitanje traži suprotno: pokrivenost više cenovnika.
 */
export function perDocumentLimit(question: string): number {
  const pogoci = question.match(DESTINACIJE_SVE) ?? [];
  const jedinstvene = new Set(pogoci.map((p) => p.toLowerCase()));

  return jedinstvene.size === 1 ? 4 : 2;
}

export function formatDocuments(
  entries: RerankedEntry[],
  maxContextChars = 14_000,
): { context: string; sources: SourceRef[] } {
  const blocks: string[] = [];
  const sources: SourceRef[] = [];
  let total = 0;

  for (const { doc, vectorScore } of entries) {
    const content = doc.pageContent.trim();
    if (!content) continue;

    const filename = getFilename(doc);
    const label = toLabel(filename);
    const block = `[${blocks.length + 1}] ${label}\n${content}`;

    if (total + block.length > maxContextChars) break;

    blocks.push(block);
    sources.push({ label, filename, excerpt: content.slice(0, 700), score: vectorScore });
    total += block.length;
  }

  return { context: blocks.join('\n\n---\n\n'), sources };
}

// ---------------------------------------------------------------------------
// Brzi ruter
// ---------------------------------------------------------------------------

/**
 * Klasifikacija bez poziva modelu, kada je ishod nedvosmislen.
 *
 * Ruter je posle samog odgovora najskuplji deo lanca — na free tieru sa
 * dvadeset zahteva dnevno, dva poziva po pitanju znače sedam pitanja umesto
 * dvadeset.
 *
 * Vraća `null` kada nije sigurna, i tada se poziva model.
 */
export function quickRoute(question: string, hasHistory: boolean): Intent | null {
  const q = question.trim();

  if (q.length < 40 && POZDRAVI.test(q)) return 'razgovor';

  // "Ko je predsednik Francuske" pominje destinaciju, a nije pitanje o
  // cenovniku. Takve oblike prepuštamo modelu.
  if (OPSTE_ZNANJE.test(q)) return null;

  const pominjeDestinaciju = DESTINACIJE.test(q);
  const pominjePutovanje = PUTOVANJE.test(q);

  // Nijedan signal — može biti van teme, može biti nastavak.
  if (!pominjeDestinaciju && !pominjePutovanje) return null;

  // Bez istorije nastavak nije moguć.
  if (!hasHistory) return 'cenovnik';

  // Sa istorijom, ali sa izričito pomenutom destinacijom — pitanje stoji samo.
  if (pominjeDestinaciju) return 'cenovnik';

  // Ostalo su verovatno nastavci koji traže razrešavanje zamenica.
  return null;
}

// ---------------------------------------------------------------------------
// Parsiranje odgovora rutera
// ---------------------------------------------------------------------------

/**
 * Najkrhkiji deo lanca: model ume da obavije JSON u markdown ogradu, doda
 * uvodnu rečenicu, ili vrati nameru koja nije u skupu. Sve to ovde pada na
 * siguran default umesto da ruši zahtev.
 */
export function parseRouterResponse(
  raw: string,
  fallbackQuestion: string,
): { intent: Intent; standaloneQuestion: string } {
  const safe = { intent: 'cenovnik' as Intent, standaloneQuestion: fallbackQuestion };

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : cleaned) as {
      namera?: string;
      pitanje?: string;
    };

    const intent = VALID_INTENTS.includes(parsed.namera as Intent)
      ? (parsed.namera as Intent)
      : 'cenovnik';

    const rewritten = typeof parsed.pitanje === 'string' ? parsed.pitanje.trim() : '';

    return {
      intent,
      standaloneQuestion: rewritten.length > 2 ? rewritten : fallbackQuestion,
    };
  } catch {
    return safe;
  }
}