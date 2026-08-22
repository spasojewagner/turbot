import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { Check, Loader2, Trash2, TriangleAlert, Upload } from 'lucide-react';

import { fontVariables } from '@/utils/fonts';

type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

interface DocumentRecord {
  id: string;
  filename: string;
  size: number;
  uploadedAt: string;
  status: DocumentStatus;
  extraction?: 'pdf' | 'ocr';
  chunkCount?: number;
  error?: string;
}

const TOKEN_KEY = 'turbot:admin-token';

const STATUS_LABEL: Record<DocumentStatus, string> = {
  pending: 'na čekanju',
  processing: 'obrađuje se',
  ready: 'u indeksu',
  failed: 'greška',
};

const STATUS_STYLE: Record<DocumentStatus, string> = {
  pending: 'border-ink-line text-mute',
  processing: 'border-teal/40 text-teal',
  ready: 'border-teal/40 bg-teal/10 text-teal',
  failed: 'border-amber/40 bg-amber/10 text-amber',
};

const formatSize = (bytes: number) =>
  bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
    } catch {
      // Privatni režim blokira sessionStorage.
    }
  }, []);

  const headers = useCallback(
    (extra: Record<string, string> = {}) => ({
      ...(token ? { 'x-admin-token': token } : {}),
      ...extra,
    }),
    [token],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/documents', { headers: headers() });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? `Zahtev nije uspeo (${response.status}).`);
        setDocuments([]);
        return;
      }

      setDocuments(data.documents ?? []);
    } catch {
      setError('Nije moguće povezivanje sa serverom.');
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveToken = (value: string) => {
    setToken(value);
    try {
      sessionStorage.setItem(TOKEN_KEY, value);
    } catch {
      // Bez trajnog čuvanja, token važi do osvežavanja stranice.
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;

    setBusy('upload');
    setError(null);

    for (const file of Array.from(files)) {
      try {
        const response = await fetch(
          `/api/documents?filename=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            headers: headers({ 'Content-Type': 'application/pdf' }),
            body: file,
          },
        );

        const data = await response.json();
        if (!response.ok) setError(data.error ?? 'Dodavanje nije uspelo.');
      } catch {
        setError('Dodavanje nije uspelo.');
      }
    }

    setBusy(null);
    if (fileRef.current) fileRef.current.value = '';
    await load();
  };

  /**
   * Obrada se poziva u petlji, jedan dokument po zahtevu.
   *
   * Serverless funkcija ima gornju granicu trajanja, pa se sve odjednom ne
   * može. Petlja na klijentu je jednostavnija od reda poslova i dovoljna
   * pri ovom obimu.
   */
  const ingestAll = async () => {
    setBusy('ingest');
    setError(null);

    for (let i = 0; i < 50; i += 1) {
      try {
        const response = await fetch('/api/documents/ingest', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        });

        const data = await response.json();
        await load();

        if (data.error) {
          setError(data.error);
          break;
        }

        if (data.done) break;
      } catch {
        setError('Obrada nije uspela.');
        break;
      }
    }

    setBusy(null);
  };

  const remove = async (doc: DocumentRecord) => {
    if (!window.confirm(`Obrisati "${doc.filename}" i sve njegove fragmente?`)) return;

    setBusy(doc.id);
    setError(null);

    try {
      const response = await fetch(`/api/documents/${doc.id}`, {
        method: 'DELETE',
        headers: headers(),
      });

      const data = await response.json();
      if (!response.ok) setError(data.error ?? 'Brisanje nije uspelo.');
    } catch {
      setError('Brisanje nije uspelo.');
    }

    setBusy(null);
    await load();
  };

  const naCekanju = documents.filter(
    (d) => d.status === 'pending' || d.status === 'failed',
  ).length;
  const fragmenata = documents.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);

  return (
    <>
      <Head>
        <title>TurBot, dokumenti</title>
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#080E15" />
      </Head>

      <div
        className={`${fontVariables} min-h-[100dvh] bg-ink-deep font-sans text-paper antialiased`}
      >
        <header className="border-b border-ink-line/70">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-3">
            <Link
              href="/"
              className="rounded-control font-display text-base font-medium tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
            >
              Tur<span className="text-amber">Bot</span>
            </Link>
            <span className="font-mono text-xs uppercase tracking-eyebrow text-mute">
              dokumenti
            </span>
          </div>
        </header>

        <main className="mx-auto max-w-4xl px-5 py-8">
          <div className="mb-6">
            <label
              htmlFor="token"
              className="mb-1.5 block font-mono text-[11px] uppercase tracking-eyebrow text-mute"
            >
              pristupni token
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => saveToken(e.target.value)}
              onBlur={() => void load()}
              placeholder="ADMIN_TOKEN iz podešavanja"
              className="w-full max-w-sm rounded-panel border border-ink-line bg-ink-soft px-3 py-2.5 font-mono text-sm transition-colors duration-150 ease-out placeholder:text-mute focus:border-mute focus:outline-none"
            />
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              multiple
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
            />

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
              className="flex h-11 items-center gap-2 rounded-panel bg-amber px-5 font-mono text-sm font-medium text-ink transition-[opacity,transform] duration-150 ease-out hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber active:scale-[0.97] disabled:opacity-30"
            >
              {busy === 'upload' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-4 w-4" aria-hidden="true" />
              )}
              dodaj cenovnike
            </button>

            <button
              type="button"
              onClick={() => void ingestAll()}
              disabled={busy !== null || naCekanju === 0}
              className="flex h-11 items-center gap-2 rounded-panel border border-ink-line px-5 font-mono text-sm text-paper-dim transition-colors duration-150 ease-out hover:border-teal hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal active:scale-[0.97] disabled:opacity-30"
            >
              {busy === 'ingest' && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              obradi na čekanju
              {naCekanju > 0 && <span className="text-amber">{naCekanju}</span>}
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-6 flex animate-enter items-start gap-2 rounded-panel border border-amber/35 bg-amber/10 px-4 py-3"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden="true" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          <p className="mb-3 font-mono text-[11px] uppercase tracking-eyebrow text-mute">
            {documents.length} dokumenata, {fragmenata} fragmenata u indeksu
          </p>

          {loading ? (
            <p className="py-8 text-center font-mono text-xs text-mute">učitavam</p>
          ) : documents.length === 0 ? (
            <div className="rounded-surface border border-dashed border-ink-line px-6 py-12 text-center">
              <p className="text-mute-light">Nema dodatih cenovnika.</p>
              <p className="mt-1 text-sm text-mute">
                Dodaj PDF, pa pokreni obradu da uđe u indeks.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="flex items-center gap-3 rounded-panel border border-ink-line bg-ink-soft px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-paper">{doc.filename}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-mute">
                      {formatSize(doc.size)}
                      {typeof doc.chunkCount === 'number' &&
                        `, ${doc.chunkCount} fragmenata`}
                      {doc.extraction === 'ocr' && ', pročitano modelom'}
                    </p>
                    {doc.error && (
                      <p className="mt-1 font-mono text-[11px] text-amber">{doc.error}</p>
                    )}
                  </div>

                  <span
                    className={`flex shrink-0 items-center gap-1.5 rounded-control border px-2 py-1 font-mono text-[11px] ${STATUS_STYLE[doc.status]}`}
                  >
                    {doc.status === 'ready' && <Check className="h-3 w-3" aria-hidden="true" />}
                    {doc.status === 'processing' && (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    )}
                    {STATUS_LABEL[doc.status]}
                  </span>

                  <button
                    type="button"
                    onClick={() => void remove(doc)}
                    disabled={busy !== null}
                    aria-label={`Obriši ${doc.filename}`}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-mute transition-colors duration-150 ease-out hover:text-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber active:scale-[0.97] disabled:opacity-30"
                  >
                    {busy === doc.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-8 font-mono text-[11px] leading-relaxed text-mute">
            Brisanje uklanja i fragmente iz vektorske baze. Skenirani cenovnici se
            čitaju modelom, a prepis se čuva da se isti posao ne plati dvaput.
          </p>
        </main>
      </div>
    </>
  );
}