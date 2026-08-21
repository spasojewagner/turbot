import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Uvodni snimak: kontinuirani zum iz orbite do plaže.
 *
 * Video je bez audio zapisa. Ne zato što je tiši, nego zato što browseri
 * blokiraju automatsko puštanje svega što ima zvuk. Bez audio trake atribut
 * `muted` garantovano prolazi.
 */
const DURATION_MS = 5100;
/** Kada se pojavljuje potpis, pred kraj snimka. */
const TITLE_AT_MS = 3600;
/**
 * Ako `ended` nikad ne stigne (prekinut prenos, agresivan štedljivi režim),
 * uvod se ipak zatvara.
 */
const SAFETY_MS = DURATION_MS + 3000;

const SESSION_KEY = 'turbot:intro-seen';

export default function Intro({ onDone }: { onDone: () => void }) {
  const [showTitle, setShowTitle] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [stalled, setStalled] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const doneRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;

    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];

    try {
      sessionStorage.setItem(SESSION_KEY, '1');
    } catch {
      // Privatni režim blokira sessionStorage.
    }

    setLeaving(true);
    window.setTimeout(onDone, 500);
  }, [onDone]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const push = (fn: () => void, ms: number) => {
      timersRef.current.push(window.setTimeout(fn, ms));
    };

    push(() => setShowTitle(true), TITLE_AT_MS);
    push(finish, SAFETY_MS);

    // Automatsko puštanje ume da bude odbijeno uprkos atributu `muted`
    // (štednja baterije, podešavanja privatnosti). U tom slučaju nema smisla
    // držati posetioca na statičnom kadru.
    const attempt = video.play();
    if (attempt) {
      attempt.catch(() => {
        setStalled(true);
        push(finish, 700);
      });
    }

    return () => {
      timersRef.current.forEach(window.clearTimeout);
      timersRef.current = [];
    };
  }, [finish]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish]);

  return (
    <div
      role="presentation"
      onClick={finish}
      className={`fixed inset-0 z-50 cursor-pointer overflow-hidden bg-ink transition-opacity duration-500 ease-out ${
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        poster="/intro/poster.jpg"
        preload="auto"
        muted
        playsInline
        autoPlay
        onEnded={finish}
        onError={finish}
        aria-hidden="true"
      >
        <source src="/intro/intro.webm" type="video/webm" />
        <source src="/intro/intro.mp4" type="video/mp4" />
      </video>

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/80 via-transparent to-ink/25" />

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-16 text-center transition-all duration-500 ease-out sm:pb-20 ${
          showTitle && !stalled ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        }`}
      >
        <p className="font-display text-[clamp(1.75rem,5vw,3rem)] font-medium tracking-tight text-paper">
          Odgovor ima izvor.
        </p>
        <p className="mt-3 font-mono text-xs uppercase tracking-eyebrow text-amber">turbot</p>
      </div>

      {/*
        Dugme ostaje vidljivo do kraja. Ranije je nestajalo kad se pojavi
        potpis, pa je posetilac koji je hteo da preskoči poslednju sekundu
        ostajao bez načina osim da pogodi da klik bilo gde radi.
      */}
      <button
        type="button"
        onClick={finish}
        className="absolute bottom-6 right-6 rounded-panel border border-paper/25 px-3 py-2 font-mono text-xs text-paper/70 transition-colors duration-150 ease-out hover:border-amber hover:text-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber active:scale-[0.97]"
      >
        preskoči
      </button>
    </div>
  );
}

/** Uvod se pušta jednom po sesiji i nikada uz uključeno smanjeno kretanje. */
export function shouldPlayIntro(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;

  try {
    return sessionStorage.getItem(SESSION_KEY) !== '1';
  } catch {
    return true;
  }
}