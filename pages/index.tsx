import { useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Head from 'next/head';

import { fontVariables } from '@/utils/fonts';
import { DESTINATIONS } from '@/components/Globe';

const Globe = dynamic(() => import('@/components/Globe'), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

const PRIMERI = [
  'Koje ponude imate za Rim za prvi maj',
  'Šta je uključeno u cenu za Istanbul',
  'Polasci avionom u maju',
];

export default function Landing() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const router = useRouter();

  const go = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    void router.push(`/chat?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <>
      <Head>
        <title>TurBot — pretraga cenovnika putovanja</title>
        <meta
          name="description"
          content="Pitaj o aranžmanima. Odgovori dolaze iz cenovnika i programa putovanja, sa navedenim izvorom."
        />
      </Head>

      <main
        className={`${fontVariables} relative flex min-h-screen flex-col overflow-hidden bg-ink font-sans text-paper antialiased`}
      >
        {/* Globus je iza sadržaja na mobilnom, pored njega na širokim ekranima. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 opacity-40 sm:opacity-60 lg:pointer-events-auto lg:-right-[10%] lg:w-[58%] lg:opacity-100">
          <Globe activeIndex={active} />
        </div>

        <div className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 lg:px-10">
          <header className="flex shrink-0 items-center justify-between py-7">
            <span className="font-display text-lg font-medium tracking-tight">
              Tur<span className="text-amber">Bot</span>
            </span>
            <a
              href="/chat"
              className="rounded-md border border-ink-line px-4 py-2 font-mono text-xs text-mute-light transition-colors hover:border-amber hover:text-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
            >
              otvori chat
            </a>
          </header>

          <div className="flex flex-1 flex-col justify-center py-10 lg:max-w-lg">
            <p className="animate-fade-up font-mono text-xs uppercase tracking-eyebrow text-teal">
              <span className="text-amber">{DESTINATIONS.length}</span> destinacija
              <span className="mx-2 text-ink-line">/</span>
              <span className="text-amber">737</span> odlomaka
            </p>

            <h1 className="mt-5 animate-fade-up font-display text-[2.75rem] font-medium leading-[1.05] tracking-tight sm:text-6xl">
              Pitaj o cenovniku.
              <br />
              <span className="text-mute">Odgovor ima izvor.</span>
            </h1>

            <p className="mt-5 max-w-sm animate-fade-up leading-relaxed text-mute-light">
              Cene, termini polaska, brojevi letova i šta je uključeno — izvučeno iz
              programa putovanja. Kada podatka nema, TurBot to kaže umesto da ga izmisli.
            </p>

            <div className="mt-8 animate-fade-up">
              <label htmlFor="q" className="sr-only">
                Vaše pitanje
              </label>
              <div className="flex items-center gap-2 rounded-xl border border-ink-line bg-ink-soft p-1.5 transition-colors focus-within:border-amber/70">
                <input
                  id="q"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && go(query)}
                  placeholder="Koliko košta Rim avionom u maju?"
                  className="min-w-0 flex-1 bg-transparent px-3 py-2.5 placeholder:text-mute focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => go(query)}
                  disabled={!query.trim()}
                  className="shrink-0 rounded-lg bg-amber px-5 py-2.5 font-mono text-sm font-medium text-ink transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber disabled:opacity-25"
                >
                  pitaj
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {PRIMERI.map((primer) => (
                  <button
                    key={primer}
                    type="button"
                    onClick={() => go(primer)}
                    className="rounded-full border border-ink-line px-3 py-1.5 text-sm text-mute-light transition-colors hover:border-teal hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                  >
                    {primer}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/*
            Lista je legenda globusa: hover ili fokus ističe odgovarajući luk.
            Bez te veze bila bi samo dekorativan niz reči.
          */}
          <footer className="shrink-0 border-t border-ink-line/50 py-5">
            <p className="mb-3 font-mono text-[11px] uppercase tracking-eyebrow text-mute">
              u indeksu
            </p>
            <ul className="flex flex-wrap gap-x-1 gap-y-1">
              {DESTINATIONS.map((d, i) => (
                <li key={d.name}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    onClick={() => go(`Koje ponude imate za ${d.name}`)}
                    className={`rounded px-2 py-1 font-mono text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber ${
                      active === i ? 'bg-amber/10 text-amber' : 'text-mute hover:text-paper'
                    }`}
                  >
                    {d.name.toLowerCase()}
                  </button>
                </li>
              ))}
            </ul>
          </footer>
        </div>
      </main>
    </>
  );
}