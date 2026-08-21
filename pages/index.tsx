import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, ArrowUp, MessageSquare, Shuffle } from 'lucide-react';

import { fontVariables } from '@/utils/fonts';
import { DESTINATIONS } from '@/components/Globe';
import { shouldPlayIntro } from '@/components/Intro';

const Globe = dynamic(() => import('@/components/Globe'), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

const Intro = dynamic(() => import('@/components/Intro'), { ssr: false });

/** Broj fragmenata u indeksu. Proveriti posle svake re-indeksacije. */
const ODLOMAKA = 431;

const PRIMERI = [
  'Koje ponude imate za Rim za prvi maj, avionom, za dvoje?',
  'Šta je tačno uključeno u cenu aranžmana za Istanbul?',
  'Aranžmani sa četiri noćenja i doručkom, do 700 € po osobi',
  'Koji su termini polaska za Maltu i koliko traju?',
  'Ima li polazaka iz Beograda 30. aprila?',
];

const PRIMER_MS = 4200;
const RUTA_MS = 2600;

/**
 * Ticker ruta u navigaciji.
 *
 * Vizuelno ponavlja lukove sa globusa, pa nav i pozadina govore istu stvar.
 * Prelaz je 200ms jer se ponavlja često; duži bi počeo da smeta.
 */
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
      }, 200);
    }, RUTA_MS);

    return () => window.clearInterval(id);
  }, []);

  const destination = DESTINATIONS[index];

  return (
    <button
      type="button"
      onClick={() => onSelect(destination.name)}
      className="hidden items-center gap-2 rounded-panel px-3 py-2 font-mono text-xs lowercase text-mute transition-colors duration-150 ease-out hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal md:flex"
    >
      <span>beograd</span>
      <ArrowRight className="h-3 w-3 text-ink-line" aria-hidden="true" />
      <span
        className={`min-w-[7.5rem] text-left text-amber transition-opacity duration-200 ease-out ${
          visible ? 'opacity-100' : 'opacity-0'
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
  const [introDone, setIntroDone] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  /**
   * Kreće se od pretpostavke da uvod ide.
   *
   * Obrnuto bi značilo da se u prvom renderu, pre nego što useEffect stigne
   * da proveri sessionStorage, landing prikaže pa sakrije. To je bljesak od
   * pola sekunde pre nego što snimak krene.
   */
  useEffect(() => {
    if (!shouldPlayIntro()) setIntroDone(true);
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

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const shuffle = () => {
    setQuery(PRIMERI[Math.floor(Math.random() * PRIMERI.length)]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      resize();
    });
  };

  return (
    <>
      <Head>
        <title>TurBot, pretraga cenovnika putovanja</title>
        <meta
          name="description"
          content="Pitaj o aranžmanima. Odgovori dolaze iz cenovnika i programa putovanja, sa navedenim izvorom."
        />
        <meta name="theme-color" content="#0B1A2A" />
      </Head>

      {!introDone && <Intro onDone={() => setIntroDone(true)} />}

      <main
        className={`${fontVariables} relative flex min-h-[100dvh] flex-col overflow-hidden bg-ink font-sans text-paper antialiased transition-opacity duration-500 ease-out ${
          introDone ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/*
          Na uskim ekranima globus je prigušen jače: dvadeset lukova iza
          teksta na 380px je šum, ne pozadina.
        */}
        <div className="absolute inset-0 opacity-30 sm:opacity-50 lg:opacity-75">
          <Globe activeIndex={active} />
        </div>

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink via-ink/60 to-ink" />

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 lg:px-10">
          <nav className="flex shrink-0 items-center justify-between py-4">
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
              <span className="select-none font-display text-lg font-medium tracking-tight">
                Tur<span className="text-amber">Bot</span>
              </span>
            </div>

            <RouteTicker onSelect={(name) => go(`Koje ponude imate za ${name}`)} />

            <Link
              href="/chat"
              aria-label="Otvori chat"
              title="Otvori chat"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-ink-line text-mute-light transition-colors duration-150 ease-out hover:border-amber hover:text-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber active:scale-[0.97]"
            >
              <MessageSquare className="h-[18px] w-[18px]" aria-hidden="true" />
            </Link>
          </nav>

          <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
            {/*
              Hijerarhija se drži težinom i bojom, ne veličinom. Raniji naslov
              je išao do 4.25rem i nadjačavao polje za unos, koje je zapravo
              glavna radnja na stranici.
            */}
            <h1 className="max-w-2xl animate-enter text-balance font-display text-[clamp(2.25rem,5vw,3.25rem)] font-medium leading-[1.06] tracking-[-0.02em]">
              Gde ideš sledeće?
            </h1>

            <p
              className="mt-4 max-w-[46ch] animate-enter text-[17px] leading-relaxed text-mute-light"
              style={{ animationDelay: '60ms' }}
            >
              Reci kuda i kada. Vadim cene, termine i sadržaj aranžmana pravo iz
              cenovnika, i pokazujem ti odakle.
            </p>

            {/*
              Kartica je flex kolona, ne blok sa apsolutno pozicioniranim
              dugmadima. Raniji raspored je tražio ručno izračunat padding na
              dnu, koji bi pukao čim polje poraste preko dva reda.
            */}
            <div
              className="mt-8 w-full max-w-2xl animate-enter"
              style={{ animationDelay: '120ms' }}
            >
              <div className="flex flex-col gap-4 rounded-surface border border-paper/12 bg-ink-soft/80 p-4 text-left backdrop-blur-xl transition-colors duration-200 ease-out focus-within:border-amber/50">
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
                  className="w-full resize-none bg-transparent px-2 pt-1 text-[17px] leading-relaxed text-paper placeholder:text-amber/50 focus:outline-none"
                />

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={shuffle}
                    aria-label="Ubaci nasumičan primer pitanja"
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-paper/15 text-mute-light transition-colors duration-150 ease-out hover:border-teal hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal active:scale-[0.97]"
                  >
                    <Shuffle className="h-[18px] w-[18px]" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    onClick={() => go(query)}
                    disabled={!query.trim()}
                    className="flex h-12 items-center gap-2 rounded-full bg-amber px-6 font-mono text-sm font-medium uppercase tracking-eyebrow text-ink transition-[opacity,transform] duration-150 ease-out hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber active:scale-[0.97] disabled:opacity-25 disabled:active:scale-100"
                  >
                    pitaj
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/*
            Lista je legenda globusa: hover ili fokus ističe odgovarajući luk.
            Bez te veze bila bi samo dekorativan niz reči.
          */}
          <footer className="shrink-0 border-t border-ink-line/40 py-4">
            <p className="mb-3 text-center font-mono text-[11px] uppercase tracking-eyebrow text-mute">
              {DESTINATIONS.length} destinacija, {ODLOMAKA} odlomaka u indeksu
            </p>
            <ul className="flex flex-wrap justify-center gap-1">
              {DESTINATIONS.map((d, i) => (
                <li key={d.name}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    onClick={() => go(`Koje ponude imate za ${d.name}`)}
                    className={`rounded-control px-2 py-1 font-mono text-xs transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber ${
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