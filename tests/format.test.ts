import { describe, expect, it } from 'vitest';
import { Document } from '@langchain/core/documents';

import {
  diversify,
  formatDocuments,
  getFilename,
  normalizeHistory,
  parseRouterResponse,
  perDocumentLimit,
  quickRoute,
  rerank,
  renderTurns,
  toLabel,
  type RerankedEntry,
} from '@/lib/rag/format';

const doc = (filename: string, content = 'sadržaj') =>
  new Document({ pageContent: content, metadata: { filename } });

/** Pomoćnik: pravi RerankedEntry bez prolaska kroz rerank. */
const entry = (filename: string, content = 'sadržaj', score = 0.8): RerankedEntry => ({
  doc: doc(filename, content),
  vectorScore: score,
  finalScore: score,
  signals: [],
});

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

describe('rerank', () => {
  it('podiže fragment sa cenom kada se pita za cenu', () => {
    const scored: [Document, number][] = [
      [doc('a.pdf', 'Program obuhvata razgledanje grada uz vodiča.'), 0.80],
      [doc('b.pdf', 'HOTEL 3*** redovna cena 549€ snižena 499€'), 0.75],
    ];

    const result = rerank('Koliko košta Rim?', scored);

    expect(getFilename(result[0].doc)).toBe('b.pdf');
    expect(result[0].signals).toContain('cena');
    expect(result[0].finalScore).toBeCloseTo(0.81, 5);
  });

  it('ne dira poredak kada pitanje ne traži cenu', () => {
    const scored: [Document, number][] = [
      [doc('a.pdf', 'Program obuhvata razgledanje grada.'), 0.8],
      [doc('b.pdf', 'HOTEL 3*** cena 549€'), 0.75],
    ];

    const result = rerank('Šta se obilazi u programu?', scored);
    expect(getFilename(result[0].doc)).toBe('a.pdf');
  });

  it('podiže fragment sa datumom kada se pita za termin', () => {
    const scored: [Document, number][] = [
      [doc('a.pdf', 'Smeštaj u hotelu sa tri zvezdice.'), 0.80],
      [doc('b.pdf', 'Polazak 02.05.2025. povratak 05.05.2025.'), 0.76],
    ];

    const result = rerank('Koji su termini polaska?', scored);
    expect(getFilename(result[0].doc)).toBe('b.pdf');
    expect(result[0].signals).toContain('datum');
  });

  it('sabira više signala', () => {
    const bogat = 'Termin 02.05.2025 — cena 699€ — u cenu je uključen prevoz';
    const scored: [Document, number][] = [[doc('a.pdf', bogat), 0.7]];

    const result = rerank('Koliko košta i koji je termin, šta je uključeno?', scored);
    expect(result[0].signals).toHaveLength(3);
    expect(result[0].finalScore).toBeCloseTo(0.88, 5);
  });

  it('čuva originalni skor odvojeno od konačnog', () => {
    const scored: [Document, number][] = [[doc('a.pdf', 'cena 499€'), 0.7]];
    const result = rerank('koliko košta', scored);

    expect(result[0].vectorScore).toBe(0.7);
    expect(result[0].finalScore).toBeGreaterThan(0.7);
  });

  it('zadržava redosled pretrage pri jednakom skoru', () => {
    const scored: [Document, number][] = [
      [doc('prvi.pdf', 'tekst'), 0.8],
      [doc('drugi.pdf', 'tekst'), 0.8],
    ];

    const result = rerank('nešto neutralno', scored);
    expect(result.map((r) => getFilename(r.doc))).toEqual(['prvi.pdf', 'drugi.pdf']);
  });

  it('ne ruši se na praznom nizu', () => {
    expect(rerank('bilo šta', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('diversify', () => {
  it('ograničava broj fragmenata po dokumentu', () => {
    const entries = [
      entry('Malta.pdf', 'a', 0.9),
      entry('Malta.pdf', 'b', 0.88),
      entry('Malta.pdf', 'c', 0.87),
      entry('Rim.pdf', 'd', 0.86),
    ];

    const result = diversify(entries, 2);
    expect(result).toHaveLength(3);
    expect(result.map((r) => getFilename(r.doc))).toEqual([
      'Malta.pdf',
      'Malta.pdf',
      'Rim.pdf',
    ]);
  });

  it('čuva redosled', () => {
    const entries = [entry('a.pdf', 'x', 0.9), entry('b.pdf', 'y', 0.8)];
    expect(diversify(entries, 1).map((r) => r.finalScore)).toEqual([0.9, 0.8]);
  });

  it('ne dira rezultat kada nema duplikata', () => {
    const entries = [entry('a.pdf'), entry('b.pdf')];
    expect(diversify(entries, 2)).toHaveLength(2);
  });
});

describe('perDocumentLimit', () => {
  it('daje veći limit kada je pomenuta jedna destinacija', () => {
    expect(perDocumentLimit('Koliko košta Rim avionom tri noćenja?')).toBe(4);
    expect(perDocumentLimit('Šta je uključeno u cenu za Maltu?')).toBe(4);
  });

  it('daje niži limit kada je pomenuto više destinacija', () => {
    expect(perDocumentLimit('Uporedi Rim, Istanbul i Amsterdam')).toBe(2);
  });

  it('daje niži limit kada nijedna destinacija nije pomenuta', () => {
    expect(perDocumentLimit('Aranžmani do 700 € po osobi')).toBe(2);
  });

  it('ne broji ponavljanje iste destinacije kao više njih', () => {
    expect(perDocumentLimit('Rim, i to Rim avionom, koliko košta Rim?')).toBe(4);
  });
});

describe('formatDocuments', () => {
  it('numeriše izvore i dodaje naziv aranžmana', () => {
    const { context } = formatDocuments([entry('Rim_Avio.pdf', 'cena 699 €')]);
    expect(context).toContain('[1] Rim Avio');
    expect(context).toContain('cena 699 €');
  });

  it('preskače prazne fragmente', () => {
    const { sources } = formatDocuments([
      entry('a.pdf', '   '),
      entry('b.pdf', 'ima sadržaja'),
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0].filename).toBe('b.pdf');
  });

  it('poštuje budžet konteksta', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry(`f${i}.pdf`, 'x'.repeat(100)),
    );
    expect(formatDocuments(entries, 250).sources.length).toBeLessThan(10);
  });

  it('u izvore ide originalni skor, ne podignuti', () => {
    const { sources } = formatDocuments([
      { ...entry('a.pdf', 'tekst', 0.77), finalScore: 0.89 },
    ]);
    expect(sources[0].score).toBe(0.77);
  });
});

// ---------------------------------------------------------------------------

describe('quickRoute', () => {
  it('prepoznaje pozdrav bez poziva modelu', () => {
    expect(quickRoute('Zdravo', false)).toBe('razgovor');
    expect(quickRoute('hvala ti puno', false)).toBe('razgovor');
    expect(quickRoute('Dobar dan', true)).toBe('razgovor');
  });

  it('ne proglašava dugačko pitanje pozdravom', () => {
    const dugacko = 'Zdravo, zanima me koliko košta aranžman za Rim u maju za dvoje';
    expect(quickRoute(dugacko, false)).toBe('cenovnik');
  });

  it('prepoznaje pitanje o cenovniku bez istorije', () => {
    expect(quickRoute('Koliko košta Rim?', false)).toBe('cenovnik');
    expect(quickRoute('Koji su termini polaska?', false)).toBe('cenovnik');
    expect(quickRoute('Ima li slobodnih hotela?', false)).toBe('cenovnik');
  });

  it('prepoznaje samostalno pitanje i kada postoji istorija', () => {
    expect(quickRoute('A koliko košta Istanbul?', true)).toBe('cenovnik');
    expect(quickRoute('Šta imate za Maltu?', true)).toBe('cenovnik');
  });

  it('prepušta modelu nastavak bez pomenute destinacije', () => {
    expect(quickRoute('a koliko to košta?', true)).toBeNull();
    expect(quickRoute('šta je uključeno?', true)).toBeNull();
  });

  it('prepušta modelu pitanja bez ijednog signala', () => {
    expect(quickRoute('koliko je 2+2', false)).toBeNull();
  });

  it('prepušta modelu pitanja opšteg znanja koja pominju destinaciju', () => {
    expect(quickRoute('ko je predsednik Francuske', false)).toBeNull();
    expect(quickRoute('gde se nalazi Malta', false)).toBeNull();
    expect(quickRoute('koji je glavni grad Portugala', false)).toBeNull();
  });

  it('radi bez dijakritike', () => {
    expect(quickRoute('koliko kosta Rim', false)).toBe('cenovnik');
    expect(quickRoute('koji su termini za Svajcarsku', false)).toBe('cenovnik');
  });

  it('poklapa se i na izmenjene oblike reči', () => {
    expect(quickRoute('koji su termini polaska', false)).toBe('cenovnik');
    expect(quickRoute('ima li hotela sa bazenom', false)).toBe('cenovnik');
    expect(quickRoute('šta imate za Maltu', false)).toBe('cenovnik');
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