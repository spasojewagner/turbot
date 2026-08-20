import { Document } from '@langchain/core/documents';

/**
 * Čiste funkcije izvučene iz `utils/makechain.ts`.
 *
 * Razlog za izdvajanje je testabilnost: sve ovde je bez mrežnih poziva i bez
 * stanja, pa se pokriva jediničnim testovima bez ijednog poziva ka modelu.
 * Ono što ostaje u makechain-u su promptovi i orkestracija.
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

/** Čitljiv naziv aranžmana iz imena fajla. */
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

/** Odbacuje sve što ne odgovara obliku [pitanje, odgovor]. */
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

/**
 * Ograničava broj fragmenata po dokumentu, čuvajući redosled po skoru.
 *
 * Bez ovoga pitanje o jednoj destinaciji vrati osam komada istog PDF-a, pa
 * pitanja tipa "aranžmani do 700 €" nikad ne vide više ponuda odjednom.
 */
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
// Ruter
// ---------------------------------------------------------------------------

/**
 * Parsira odgovor rutera.
 *
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
