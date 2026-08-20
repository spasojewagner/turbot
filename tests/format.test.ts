import { describe, expect, it } from 'vitest';
import { Document } from '@langchain/core/documents';

import {
  diversify,
  formatDocuments,
  getFilename,
  normalizeHistory,
  parseRouterResponse,
  renderTurns,
  toLabel,
} from '@/lib/rag/format';

const doc = (filename: string, content = 'sadržaj') =>
  new Document({ pageContent: content, metadata: { filename } });

// ---------------------------------------------------------------------------

describe('getFilename', () => {
  it('uzima filename iz metapodataka', () => {
    expect(getFilename(doc('Rim.pdf'))).toBe('Rim.pdf');
  });

  it('izvlači ime iz source putanje kada filename ne postoji', () => {
    const d = new Document({
      pageContent: 'x',
      metadata: { source: 'docs/Malta_cenovnik.pdf' },
    });
    expect(getFilename(d)).toBe('Malta_cenovnik.pdf');
  });

  it('radi i sa Windows putanjama', () => {
    const d = new Document({
      pageContent: 'x',
      metadata: { source: 'C:\\turbot\\docs\\Rim.pdf' },
    });
    expect(getFilename(d)).toBe('Rim.pdf');
  });

  it('vraća zamenu kada metapodataka nema', () => {
    expect(getFilename(new Document({ pageContent: 'x' }))).toBe('nepoznat izvor');
  });
});

describe('toLabel', () => {
  it('skida ekstenziju i pretvara donje crte u razmake', () => {
    expect(toLabel('Rim_Avio_Prvi_Maj_3_nocenja.pdf')).toBe('Rim Avio Prvi Maj 3 nocenja');
  });

  it('uklanja sufiks "(kliknuti za prikaz)"', () => {
    expect(toLabel('01Cenovnik i program putovanja BUS (kliknuti za prikaz).pdf')).toBe(
      '01Cenovnik i program putovanja BUS',
    );
  });

  it('sažima višestruke razmake', () => {
    expect(toLabel('a___b---c.pdf')).toBe('a b c');
  });
});

// ---------------------------------------------------------------------------

describe('normalizeHistory', () => {
  it('propušta ispravne parove', () => {
    expect(normalizeHistory([['p', 'o']])).toEqual([['p', 'o']]);
  });

  it('odbacuje sve što nije niz', () => {
    expect(normalizeHistory('nije niz')).toEqual([]);
    expect(normalizeHistory(null)).toEqual([]);
    expect(normalizeHistory(undefined)).toEqual([]);
  });

  it('odbacuje neispravne stavke unutar niza', () => {
    const input = [['p', 'o'], ['samo jedan'], [1, 2], null, ['a', 'b']];
    expect(normalizeHistory(input)).toEqual([
      ['p', 'o'],
      ['a', 'b'],
    ]);
  });

  it('zadržava samo poslednjih N razmena', () => {
    const input = Array.from({ length: 20 }, (_, i) => [`p${i}`, `o${i}`]);
    const result = normalizeHistory(input, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['p17', 'o17']);
  });
});

describe('renderTurns', () => {
  it('seče predugačke poruke', () => {
    const out = renderTurns([['x'.repeat(50), 'y']], 10);
    expect(out).toBe('Korisnik: xxxxxxxxxx\nAsistent: y');
  });

  it('vraća prazan string za praznu istoriju', () => {
    expect(renderTurns([])).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('diversify', () => {
  it('ograničava broj fragmenata po dokumentu', () => {
    const scored: [Document, number][] = [
      [doc('Malta.pdf'), 0.9],
      [doc('Malta.pdf'), 0.88],
      [doc('Malta.pdf'), 0.87],
      [doc('Rim.pdf'), 0.86],
    ];

    const result = diversify(scored, 2);
    expect(result).toHaveLength(3);
    expect(result.map(([d]) => getFilename(d))).toEqual([
      'Malta.pdf',
      'Malta.pdf',
      'Rim.pdf',
    ]);
  });

  it('čuva redosled po skoru', () => {
    const scored: [Document, number][] = [
      [doc('a.pdf'), 0.9],
      [doc('b.pdf'), 0.8],
      [doc('c.pdf'), 0.7],
    ];
    expect(diversify(scored, 1).map(([, s]) => s)).toEqual([0.9, 0.8, 0.7]);
  });

  it('ne dira rezultat kada nema duplikata', () => {
    const scored: [Document, number][] = [
      [doc('a.pdf'), 0.9],
      [doc('b.pdf'), 0.8],
    ];
    expect(diversify(scored, 2)).toHaveLength(2);
  });
});

describe('formatDocuments', () => {
  it('numeriše izvore i dodaje naziv aranžmana', () => {
    const { context } = formatDocuments([[doc('Rim_Avio.pdf', 'cena 699 €'), 0.9]]);
    expect(context).toContain('[1] Rim Avio');
    expect(context).toContain('cena 699 €');
  });

  it('preskače prazne fragmente', () => {
    const { sources } = formatDocuments([
      [doc('a.pdf', '   '), 0.9],
      [doc('b.pdf', 'ima sadržaja'), 0.8],
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0].filename).toBe('b.pdf');
  });

  it('poštuje budžet konteksta', () => {
    const scored: [Document, number][] = Array.from({ length: 10 }, (_, i) => [
      doc(`f${i}.pdf`, 'x'.repeat(100)),
      0.9,
    ]);

    const { sources } = formatDocuments(scored, 250);
    expect(sources.length).toBeLessThan(10);
  });

  it('prenosi skor u izvore', () => {
    const { sources } = formatDocuments([[doc('a.pdf', 'tekst'), 0.77]]);
    expect(sources[0].score).toBe(0.77);
  });
});

// ---------------------------------------------------------------------------

describe('parseRouterResponse', () => {
  it('parsira čist JSON', () => {
    const raw = '{"namera": "van_teme", "pitanje": "koliko je 2+2"}';
    expect(parseRouterResponse(raw, 'original')).toEqual({
      intent: 'van_teme',
      standaloneQuestion: 'koliko je 2+2',
    });
  });

  it('parsira JSON u markdown ogradi', () => {
    const raw = '```json\n{"namera": "cenovnik", "pitanje": "cena Rima"}\n```';
    expect(parseRouterResponse(raw, 'original').intent).toBe('cenovnik');
  });

  it('parsira JSON sa uvodnim tekstom', () => {
    const raw = 'Evo odgovora:\n{"namera": "nastavak", "pitanje": "a cena?"}';
    expect(parseRouterResponse(raw, 'original').intent).toBe('nastavak');
  });

  it('pada na cenovnik kada je namera nepoznata', () => {
    const raw = '{"namera": "izmisljeno", "pitanje": "nesto"}';
    expect(parseRouterResponse(raw, 'original').intent).toBe('cenovnik');
  });

  it('pada na originalno pitanje kada JSON nije validan', () => {
    expect(parseRouterResponse('ovo nije json', 'original')).toEqual({
      intent: 'cenovnik',
      standaloneQuestion: 'original',
    });
  });

  it('pada na originalno pitanje kada je prepis prekratak', () => {
    const raw = '{"namera": "cenovnik", "pitanje": "a"}';
    expect(parseRouterResponse(raw, 'original').standaloneQuestion).toBe('original');
  });

  it('ne ruši se na praznom odgovoru', () => {
    expect(() => parseRouterResponse('', 'original')).not.toThrow();
  });
});
