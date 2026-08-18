import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import Image from 'next/image';
import { ArrowUp, MessageSquare, Shuffle } from 'lucide-react';

import { fontVariables } from '@/utils/fonts';
import { DESTINATIONS } from '@/components/Globe';
import { shouldPlayIntro } from '@/components/Intro';

const Globe = dynamic(() => import('@/components/Globe'), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

const Intro = dynamic(() => import('@/components/Intro'), { ssr: false });

const PRIMERI = [
  'Koje ponude imate za Rim za prvi maj, avionom, za dvoje?',
  'Šta je tačno uključeno u cenu aranžmana za Istanbul?',
  'Aranžmani sa četiri noćenja i doručkom, do 700 € po osobi',
  'Koji su termini polaska za Maltu i koliko traju?',
  'Ima li polazaka iz Beograda 30. aprila?',
];

const PRIMER_MS = 4200;
const RUTA_MS = 2600;

/** Ticker ruta u navigaciji — vizuelno ponavlja lukove sa globusa. */
function RouteTicker({ onSelect }: { onSelect: (name: string) => void }) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const id = window.setInterval(() => {
      setVisible(false);
      window.setTimeout(() => {
        setIndex((i) => (i + 1) % DESTINATIONS.length);
        setVisible(true);
      }, 280);
    }, RUTA_MS);

    return () => window.clearInterval(id);
  }, []);

  const destination = DESTINATIONS[index];

  return (
    <button
      type="button"
      onClick={() => onSelect(destination.name)}
      className="hidden items-center gap-2.5 rounded-full px-3 py-1.5 font-mono text-xs lowercase text-mute transition-colors hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal md:flex"
    >
      <span>beograd</span>
      <span className="text-ink-line" aria-hidden="true">
        —
      </span>
      <span
        className={`min-w-[7.5rem] text-left text-amber transition-all duration-300 ${
          visible ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        }`}
      >
        {destination.name.toLowerCase()}
      </span>
    </button>
  );
}

export default function Landing() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const [primerIndex, setPrimerIndex] = useState(0);
  const [introDone, setIntroDone] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (shouldPlayIntro()) setIntroDone(false);
  }, []);

  useEffect(() => {
    if (query) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const id = window.setInterval(
      () => setPrimerIndex((i) => (i + 1) % PRIMERI.length),
      PRIMER_MS,
    );
    return () => window.clearInterval(id);
  }, [query]);

  const go = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    void router.push(`/chat?q=${encodeURIComponent(trimmed)}`);
  };

  const shuffle = () => {
    setQuery(PRIMERI[Math.floor(Math.random() * PRIMERI.length)]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    });
  };

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <>
      <Head>
        <title>TurBot — pretraga cenovnika putovanja</title>
        <meta
          name="description"
          content="Pitaj o aranžmanima. Odgovori dolaze iz cenovnika i programa putovanja, sa navedenim izvorom."
        />
        <meta name="theme-color" content="#0B1A2A" />
      </Head>

      {!introDone && <Intro onDone={() => setIntroDone(true)} />}

      <main
        className={`${fontVariables} relative flex min-h-svh flex-col overflow-hidden bg-ink font-sans text-paper antialiased transition-opacity duration-700 ${
          introDone ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="absolute inset-0 opacity-70">
          <Globe activeIndex={active} />
        </div>

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink via-ink/55 to-ink" />

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 lg:px-10">
          <nav className="flex shrink-0 items-center justify-between py-5">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 overflow-hidden rounded-full bg-ink-raised ring-1 ring-ink-line">
                <Image
                  src="/robot.png"
                  alt=""
                  width={72}
                  height={72}
                  className="h-full w-full object-cover"
                  priority
                />
              </div>
              <span className="select-none font-display text-xl font-medium tracking-tight">
                Tur<span className="text-amber">Bot</span>
              </span>
            </div>

            <RouteTicker onSelect={(name) => go(`Koje ponude imate za ${name}`)} />

            <a
              href="/chat"
              aria-label="Otvori chat"
              title="Otvori chat"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-ink-line text-mute-light transition-colors hover:border-amber hover:text-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
            >
              <MessageSquare className="h-[18px] w-[18px]" aria-hidden="true" />
            </a>
          </nav>

          <div className="flex flex-1 flex-col items-center justify-center pb-14 pt-6 text-center">
            <h1 className="max-w-3xl animate-fade-up font-display text-[clamp(2.5rem,6vw,4.25rem)] font-medium leading-[1.03] tracking-tight">
              Gde ideš sledeće?
            </h1>

            <p className="mt-5 max-w-md animate-fade-up text-lg leading-relaxed text-mute-light">
              Reci kuda i kada. Vadim cene, termine i sadržaj aranžmana pravo iz
              cenovnika — i pokazujem ti odakle.
            </p>

            <div className="mt-9 w-full max-w-2xl animate-fade-up">
              <div className="relative rounded-[2rem] border border-paper/15 bg-ink-soft/70 p-6 pb-20 text-left backdrop-blur-xl transition-colors focus-within:border-amber/60">
                <label htmlFor="q" className="sr-only">
                  Vaše pitanje
                </label>
                <textarea
                  id="q"
                  ref={textareaRef}
                  rows={2}
                  value={query}
                  maxLength={600}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    resize();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      go(query);
                    }
                  }}
                  placeholder={PRIMERI[primerIndex]}
                  className="w-full resize-none bg-transparent text-lg leading-relaxed text-paper placeholder:text-amber/55 focus:outline-none"
                />

                <button
                  type="button"
                  onClick={shuffle}
                  aria-label="Ubaci nasumičan primer pitanja"
                  className="absolute bottom-5 left-6 flex h-11 w-11 items-center justify-center rounded-full border border-paper/20 text-mute-light transition-colors hover:border-teal hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                >
                  <Shuffle className="h-[18px] w-[18px]" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  onClick={() => go(query)}
                  disabled={!query.trim()}
                  className="absolute bottom-5 right-5 flex h-14 items-center gap-2 rounded-full bg-amber px-7 font-mono text-sm font-medium uppercase tracking-eyebrow text-ink transition-all hover:opacity-90 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber disabled:opacity-25 disabled:active:scale-100"
                >
                  pitaj
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <footer className="shrink-0 border-t border-ink-line/40 py-5">
            <ul className="flex flex-wrap justify-center gap-x-1 gap-y-1">
              {DESTINATIONS.map((d, i) => (
                <li key={d.name}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    onClick={() => go(`Koje ponude imate za ${d.name}`)}
                    className={`rounded px-2.5 py-1 font-mono text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber ${
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