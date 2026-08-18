import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

import { fontVariables } from '@/utils/fonts';
import { useChat } from '@/hooks/useChat';
import ChatThread from '@/components/chat/ChatThread';

const MAX_LENGTH = 600;

const PREDLOZI = [
  'Koje ponude imate za Rim za prvi maj',
  'Šta je uključeno u cenu za Istanbul',
  'Aranžmani sa četiri noćenja',
];

export default function ChatPage() {
  const [draft, setDraft] = useState('');
  const [debug, setDebug] = useState(false);

  const router = useRouter();
  const { messages, pending, error, send, stop, reset, clearError } = useChat({ debug });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  /** Pitanje iz URL-a se šalje automatski, tačno jednom. */
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

  /** Auto-resize do 200px, pa scroll. */
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
      </Head>

      <div
        className={`${fontVariables} flex min-h-screen flex-col bg-paper font-sans text-ink antialiased`}
      >
        <header className="sticky top-0 z-10 border-b border-paper-line bg-paper/90 backdrop-blur">
          <div className="mx-auto flex max-w-thread items-center justify-between px-5 py-3">
            <Link
              href="/"
              className="font-display text-base font-medium tracking-tight text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
            >
              Tur<span className="text-amber-dim">Bot</span>
            </Link>

            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  reset();
                  setDraft('');
                  void router.replace('/chat', undefined, { shallow: true });
                }}
                className="rounded-md border border-paper-line px-3 py-1.5 font-mono text-xs text-mute transition-colors hover:border-mute-light hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
              >
                nova pretraga
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-thread flex-1 px-5 py-8">
          {isEmpty ? (
            <div className="pt-10">
              <h1 className="font-display text-2xl font-medium tracking-tight">
                Šta te zanima iz cenovnika?
              </h1>
              <p className="mt-2 leading-relaxed text-mute">
                Cene, termini, brojevi letova i šta je uključeno. Svaki odgovor nosi izvor.
              </p>
              <div className="mt-6 flex flex-col items-start gap-2">
                {PREDLOZI.map((predlog) => (
                  <button
                    key={predlog}
                    type="button"
                    onClick={() => void send(predlog)}
                    className="rounded-lg border border-paper-line bg-paper-card px-3.5 py-2 text-left text-sm text-mute transition-colors hover:border-teal hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
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
              className="mt-6 flex items-start justify-between gap-3 rounded-lg border border-amber/40 bg-amber/10 px-4 py-3"
            >
              <p className="text-sm text-ink">{error}</p>
              <button
                type="button"
                onClick={clearError}
                aria-label="Zatvori"
                className="font-mono text-xs text-mute hover:text-ink"
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

        <div className="sticky bottom-0 border-t border-paper-line bg-paper/90 backdrop-blur">
          <div className="mx-auto max-w-thread px-5 py-4">
            <label htmlFor="composer" className="sr-only">
              Vaše pitanje
            </label>
            <div className="flex items-end gap-2 rounded-xl border border-paper-line bg-paper-card p-1.5 transition-colors focus-within:border-teal">
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
                className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 leading-relaxed placeholder:text-mute-light focus:outline-none"
              />

              {pending ? (
                <button
                  type="button"
                  onClick={stop}
                  className="shrink-0 rounded-lg border border-paper-line px-4 py-2 font-mono text-sm text-mute transition-colors hover:text-ink"
                >
                  stani
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim()}
                  className="shrink-0 rounded-lg bg-ink px-4 py-2 font-mono text-sm text-paper transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal disabled:opacity-25"
                >
                  pitaj
                </button>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-mute-light">
              <span>enter šalje · shift+enter novi red</span>
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