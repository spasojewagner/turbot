import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowUp, Square } from 'lucide-react';

import { fontVariables } from '@/utils/fonts';
import { useChat } from '@/hooks/useChat';
import ChatThread from '@/components/chat/ChatThread';

const MAX_LENGTH = 600;

const PREDLOZI = [
  'Koje ponude imate za Rim za prvi maj',
  'Šta je uključeno u cenu za Istanbul',
  'Aranžmani sa četiri noćenja',
  'Polasci avionom u maju',
];

export default function ChatPage() {
  const [draft, setDraft] = useState('');
  const [debug, setDebug] = useState(false);

  const router = useRouter();
  const { messages, pending, error, send, stop, reset, clearError } = useChat({ debug });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  useEffect(() => {
    if (!router.isReady || seededRef.current) return;

    const q = router.query.q;
    const question = Array.isArray(q) ? q[0] : q;

    seededRef.current = true;
    if (question) void send(question);
  }, [router.isReady, router.query.q, send]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pending]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setDebug((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const question = draft.trim();
    if (!question || pending) return;
    setDraft('');
    requestAnimationFrame(resizeTextarea);
    void send(question);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const isEmpty = messages.length === 0 && !pending;

  return (
    <>
      <Head>
        <title>TurBot — chat</title>
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#080E15" />
      </Head>

      <div
        className={`${fontVariables} flex min-h-svh flex-col bg-ink-deep font-sans text-paper antialiased`}
      >
        <header className="sticky top-0 z-10 border-b border-ink-line/70 bg-ink-deep/85 backdrop-blur">
          <div className="mx-auto flex max-w-thread items-center justify-between px-5 py-3">
            <Link
              href="/"
              className="font-display text-base font-medium tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
            >
              Tur<span className="text-amber">Bot</span>
            </Link>

            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  reset();
                  setDraft('');
                  void router.replace('/chat', undefined, { shallow: true });
                }}
                className="rounded-md border border-ink-line px-3 py-1.5 font-mono text-xs text-mute transition-colors hover:border-mute hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
              >
                nova pretraga
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-thread flex-1 px-5 py-8">
          {isEmpty ? (
            <div className="flex flex-col items-center pt-10 text-center">
              <Image
                src="/robot-full.png"
                alt=""
                width={320}
                height={320}
                className="h-36 w-auto opacity-90"
                priority
              />
              <h1 className="mt-5 font-display text-2xl font-medium tracking-tight">
                Šta te zanima iz cenovnika?
              </h1>
              <p className="mt-2 max-w-sm leading-relaxed text-mute-light">
                Cene, termini, brojevi letova i šta je uključeno. Svaki odgovor nosi izvor.
              </p>

              <div className="mt-7 grid w-full gap-2 sm:grid-cols-2">
                {PREDLOZI.map((predlog) => (
                  <button
                    key={predlog}
                    type="button"
                    onClick={() => void send(predlog)}
                    className="rounded-xl border border-ink-line bg-ink-soft px-4 py-3 text-left text-sm text-mute-light transition-colors hover:border-teal hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                  >
                    {predlog}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ChatThread messages={messages} pending={pending} />
          )}

          {error && (
            <div
              role="alert"
              className="mt-6 flex items-start justify-between gap-3 rounded-lg border border-amber/35 bg-amber/10 px-4 py-3"
            >
              <p className="text-sm text-paper">{error}</p>
              <button
                type="button"
                onClick={clearError}
                className="shrink-0 font-mono text-xs text-mute transition-colors hover:text-paper"
              >
                zatvori
              </button>
            </div>
          )}

          {debug && (
            <p className="mt-6 font-mono text-xs text-mute">
              debug uključen — pogledaj Network tab za polje debug u odgovoru
            </p>
          )}

          <div ref={bottomRef} className="h-2" />
        </main>

        <div className="sticky bottom-0 bg-ink-deep/85 backdrop-blur">
          <div className="mx-auto max-w-thread px-5 pb-5 pt-2">
            <label htmlFor="composer" className="sr-only">
              Vaše pitanje
            </label>
            <div className="flex items-end gap-2 rounded-2xl border border-ink-line bg-ink-soft p-2 transition-colors focus-within:border-mute">
              <textarea
                id="composer"
                ref={textareaRef}
                rows={1}
                value={draft}
                maxLength={MAX_LENGTH}
                onChange={(e) => {
                  setDraft(e.target.value);
                  resizeTextarea();
                }}
                onKeyDown={onKeyDown}
                placeholder="Postavi pitanje o aranžmanima"
                className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 leading-relaxed placeholder:text-mute focus:outline-none"
              />

              {pending ? (
                <button
                  type="button"
                  onClick={stop}
                  aria-label="Prekini"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-line text-mute-light transition-colors hover:text-paper"
                >
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim()}
                  aria-label="Pošalji"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber text-ink transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber disabled:opacity-20"
                >
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-mute">
              <span>odgovori dolaze iz cenovnika — proveri izvor</span>
              {draft.length > MAX_LENGTH * 0.8 && (
                <span>
                  {draft.length}/{MAX_LENGTH}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}