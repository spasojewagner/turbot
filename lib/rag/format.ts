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
/**
 * Koliko fragmenata po dokumentu propustiti.
 *
 * Pitanje o jednoj destinaciji traži dubinu — tabela sa cenama, termini i
 * uslovi su u istom fajlu. Široko pitanje traži pokrivenost više cenovnika.
 * Zato granica zavisi od toga koliko je destinacija pomenuto.
 */
export function perDocumentLimit(question: string): number {
  const pogoci = question.match(DESTINACIJE);
  return pogoci && pogoci.length <= 1 ? 4 : 2;
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
// Rezultati pretrage
// ---------------------------------------------------------------------------

export function diversify(
  scored: [Document, number][],
  maxPerDocument = 2,
): [Document, number][] {
  const perDocument = new Map<string, number>();
  const kept: [Document, number][] = [];

  for (const entry of scored) {
    const filename = getFilename(entry[0]);
    const used = perDocument.get(filename) ?? 0;
    if (used >= maxPerDocument) continue;

    perDocument.set(filename, used + 1);
    kept.push(entry);
  }

  return kept;
}

export function formatDocuments(
  scored: [Document, number][],
  maxContextChars = 14_000,
): { context: string; sources: SourceRef[] } {
  const blocks: string[] = [];
  const sources: SourceRef[] = [];
  let total = 0;

  for (const [doc, score] of scored) {
    const content = doc.pageContent.trim();
    if (!content) continue;

    const filename = getFilename(doc);
    const label = toLabel(filename);
    const block = `[${blocks.length + 1}] ${label}\n${content}`;

    if (total + block.length > maxContextChars) break;

    blocks.push(block);
    sources.push({ label, filename, excerpt: content.slice(0, 700), score });
    total += block.length;
  }

  return { context: blocks.join('\n\n---\n\n'), sources };
}

// ---------------------------------------------------------------------------
// Brzi ruter
// ---------------------------------------------------------------------------

const POZDRAVI =
  /^(zdravo|ćao|cao|hej|hi|hello|dobar dan|dobro jutro|dobro veče|dobro vece|hvala|pozdrav|važi|vazi|ok|okej|super)\b/i;

/** Reči koje se javljaju u pitanjima o cenovniku. */
const PUTOVANJE =
  /\b(cen[aeiu]|košta|kosta|aranžman|aranzman|termin|polaz|povrat|noćenj|nocenj|noći|noci|hotel|smeštaj|smestaj|avion|autobus|let[oa]?v?|putovanj|ponud|doručak|dorucak|doplat|popust|taks|izlet|destinacij|rezervacij|osiguranj|prtljag|transfer|vodič|vodic|apartman|polupansion|pansion)\b/i;

/**
 * Destinacije koje se javljaju u korpusu.
 *
 * Ako pitanje pominje neku od njih, samostalno je — nije nastavak koji traži
 * razrešavanje zamenica, pa se poziv ruteru može preskočiti.
 */
const DESTINACIJE =
  /\b(rim|istanbul|malta|maroko|lisabon|porto|portugal|amsterdam|peterburg|bari|pulj|kairo|nil[ua]?|andaluzij|malag|škotsk|skotsk|englesk|francusk|pariz|ljubljan|švajcarsk|svajcarsk|ženev|zenev|bern|cirih|barselon|monako|milano|minhen|salcburg|trst|padov|španij|spanij|italij|grčk|grck|tursk|egipat|holandij|rusij|slovenij|koimbr|braga|sintr)\b/i;

/**
 * Klasifikacija bez poziva modelu, kada je ishod nedvosmislen.
 *
 * Ruter je najskuplji deo lanca posle samog odgovora — na free tieru sa
 * dvadeset zahteva dnevno, dva poziva po pitanju znače sedam pitanja umesto
 * dvadeset. Ova heuristika hvata većinu stvarnih pitanja.
 *
 * Vraća `null` kada nije sigurna, i tada se poziva model.
 */
export function quickRoute(question: string, hasHistory: boolean): Intent | null {
  const q = question.trim();

  // Pozdrav ili zahvala — kratko i prepoznatljivo.
  if (q.length < 40 && POZDRAVI.test(q)) return 'razgovor';

  const pominjeDestinaciju = DESTINACIJE.test(q);
  const pominjePutovanje = PUTOVANJE.test(q);

  if (!pominjeDestinaciju && !pominjePutovanje) {
    // Nema nijednog signala — može biti van teme, može biti nastavak.
    // Odluku prepuštamo modelu.
    return null;
  }

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