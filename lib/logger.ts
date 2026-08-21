/**
 * Strukturirano logovanje.
 *
 * Na lokalnoj mašini je dovoljno gledati terminal. Na Vercelu nije — logovi
 * su tekst iz stotina zahteva pomešanih zajedno, pa `console.log('greška')`
 * ne govori ni koji zahtev je pao ni šta se dešavalo pre toga.
 *
 * Zato svaki zapis nosi `requestId` i ide kao jedna JSON linija. Vercel
 * indeksira polja, pa se po njima može filtrirati.
 *
 * U razvoju se ispisuje čitljivo, jer JSON u terminalu nikome ne pomaže.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const isProduction = process.env.NODE_ENV === 'production';

/** Polja koja se nikada ne ispisuju, ma gde se pojavila. */
const REDACTED = new Set([
  'apiKey',
  'api_key',
  'GEMINI_API_KEY',
  'PINECONE_API_KEY',
  'authorization',
  'cookie',
]);

function redact(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (REDACTED.has(key)) {
      safe[key] = '[skriveno]';
      continue;
    }

    // Duge stringove skraćujemo — pitanja i odgovori umeju da budu ogromni.
    if (typeof value === 'string' && value.length > 300) {
      safe[key] = `${value.slice(0, 300)}…`;
      continue;
    }

    safe[key] = value;
  }

  return safe;
}

export interface Logger {
  requestId: string;
  debug(message: string, payload?: Record<string, unknown>): void;
  info(message: string, payload?: Record<string, unknown>): void;
  warn(message: string, payload?: Record<string, unknown>): void;
  error(message: string, payload?: Record<string, unknown>): void;
  /** Meri trajanje i loguje ga po završetku, uključujući i kad padne. */
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export function createLogger(requestId: string): Logger {
  const write = (level: Level, message: string, payload?: Record<string, unknown>) => {
    const entry = {
      level,
      requestId,
      message,
      ...(payload ? redact(payload) : {}),
    };

    if (isProduction) {
      const line = JSON.stringify({ ...entry, time: new Date().toISOString() });
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
      return;
    }

    // U razvoju: čitljivo, bez JSON buke.
    const extras = payload ? ` ${JSON.stringify(redact(payload))}` : '';
    const prefix = `[${requestId}] ${message}`;

    if (level === 'error') console.error(prefix + extras);
    else if (level === 'warn') console.warn(prefix + extras);
    else console.log(prefix + extras);
  };

  return {
    requestId,
    debug: (m, p) => write('debug', m, p),
    info: (m, p) => write('info', m, p),
    warn: (m, p) => write('warn', m, p),
    error: (m, p) => write('error', m, p),

    async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const start = Date.now();

      try {
        const result = await fn();
        write('info', `${label} završeno`, { ms: Date.now() - start });
        return result;
      } catch (err) {
        write('error', `${label} palo`, {
          ms: Date.now() - start,
          greska: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

/**
 * Kratak ID zahteva.
 *
 * Vercel dodaje svoj `x-vercel-id`, ali on ne postoji lokalno, pa se koristi
 * kada je dostupan a inače pravi nov.
 */
export function requestIdFrom(headers: Record<string, string | string[] | undefined>): string {
  const vercelId = headers['x-vercel-id'];
  const value = Array.isArray(vercelId) ? vercelId[0] : vercelId;

  if (typeof value === 'string' && value.length > 0) {
    // Vercel ID je dugačak i pun dvotačaka — uzimamo poslednji deo.
    return value.split(':').pop()?.slice(0, 12) ?? value.slice(0, 12);
  }

  return Math.random().toString(36).slice(2, 10);
}
