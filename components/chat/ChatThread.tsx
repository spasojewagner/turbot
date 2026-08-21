import { useState } from 'react';
import Image from 'next/image';
import ReactMarkdown, { type Components } from 'react-markdown';

import type { ChatMessage, Source, Stage } from '@/hooks/useChat';

/**
 * Markdown se stilizuje ručno jer @tailwindcss/typography nije instaliran,
 * a odgovori su gotovo uvek ugnježdene liste sa cenama i datumima.
 */
const markdown: Components = {
  p: ({ node, ...props }) => <p {...props} className="mb-3 leading-[1.7] last:mb-0" />,
  ul: ({ node, ...props }) => <ul {...props} className="mb-3 space-y-1.5 last:mb-0" />,
  ol: ({ node, ...props }) => <ol {...props} className="mb-4 space-y-3 last:mb-0" />,
  li: ({ node, ...props }) => (
    <li
      {...props}
      className="relative pl-4 leading-[1.7] before:absolute before:left-0 before:top-[0.72em] before:h-1 before:w-1 before:rounded-full before:bg-teal"
    />
  ),
  strong: ({ node, ...props }) => <strong {...props} className="font-medium text-paper" />,
  em: ({ node, ...props }) => <em {...props} className="not-italic text-paper-dim" />,
  code: ({ node, ...props }) => (
    <code
      {...props}
      className="rounded-control bg-ink-raised px-1.5 py-0.5 font-mono text-[0.9em] text-amber"
    />
  ),
  a: ({ node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-teal underline underline-offset-2"
    />
  ),
  h1: ({ node, ...props }) => <h3 {...props} className="mb-2 font-display font-medium text-paper" />,
  h2: ({ node, ...props }) => <h3 {...props} className="mb-2 font-display font-medium text-paper" />,
  h3: ({ node, ...props }) => <h3 {...props} className="mb-2 font-display font-medium text-paper" />,
  hr: () => <hr className="my-4 border-ink-line" />,
};

const STAGE_LABEL: Record<Stage, string> = {
  razumevanje: 'razumem pitanje',
  pretraga: 'pretražujem cenovnike',
  sastavljanje: 'sastavljam odgovor',
};

function Avatar() {
  return (
    <div className="mt-0.5 h-8 w-8 shrink-0 overflow-hidden rounded-full bg-ink-raised ring-1 ring-ink-line">
      <Image
        src="/robot.png"
        alt=""
        width={64}
        height={64}
        className="h-full w-full object-cover"
        priority
      />
    </div>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<number | null>(null);

  if (!sources.length) return null;

  return (
    <div className="mt-5 border-t border-ink-line pt-4">
      <p className="mb-2.5 font-mono text-[11px] uppercase tracking-eyebrow text-mute">
        izvori ({sources.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((source, i) => (
          <button
            key={`${source.filename}-${i}`}
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
            className={`rounded-control border px-2.5 py-1.5 text-left font-mono text-xs transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal ${
              open === i
                ? 'border-teal bg-teal/10 text-teal'
                : 'border-ink-line text-mute hover:border-mute hover:text-paper-dim'
            }`}
          >
            <span className="text-amber">{i + 1}</span>
            <span className="ml-1.5">{source.label}</span>
          </button>
        ))}
      </div>

      {open !== null && (
        <div className="mt-3 animate-enter rounded-panel border border-ink-line bg-ink-soft p-3.5">
          <p className="mb-2 break-all font-mono text-[11px] text-mute">
            {sources[open].filename}
            {typeof sources[open].score === 'number' && (
              <span className="ml-2 text-teal">{sources[open].score?.toFixed(2)}</span>
            )}
          </p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-mute-light">
            {sources[open].excerpt}
          </p>
        </div>
      )}
    </div>
  );
}

export default function ChatThread({
  messages,
  stage,
}: {
  messages: ChatMessage[];
  stage: Stage | null;
}) {
  return (
    /**
     * `aria-live="polite"` je obavezan: tekst stiže streamom, pa bez njega
     * čitač ekrana ne najavljuje ništa. `atomic=false` da se čita samo ono
     * što je novo, ne ceo razgovor pri svakoj promeni.
     */
    <div
      className="space-y-7"
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Razgovor"
    >
      {messages.map((message) =>
        message.role === 'user' ? (
          <div key={message.id} className="flex justify-end">
            <p className="max-w-[80%] rounded-surface rounded-br-panel bg-ink-raised px-4 py-2.5 leading-relaxed text-paper">
              {message.text}
            </p>
          </div>
        ) : (
          <div key={message.id} className="flex gap-3.5">
            <Avatar />
            <div className="min-w-0 flex-1 text-paper-dim">
              {message.text ? (
                <>
                  <ReactMarkdown components={markdown}>{message.text}</ReactMarkdown>
                  {message.streaming && (
                    <span
                      className="ml-0.5 inline-block h-[1.05em] w-[2px] animate-caret bg-amber align-text-bottom"
                      aria-hidden="true"
                    />
                  )}
                </>
              ) : (
                /* Pre prvog tokena prikazujemo u kojoj je fazi obrada. */
                <p className="flex items-center gap-2 pt-1.5 font-mono text-xs text-mute">
                  <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-amber" />
                  {stage ? STAGE_LABEL[stage] : 'obrađujem'}
                </p>
              )}

              {!message.streaming && <SourceList sources={message.sources ?? []} />}
            </div>
          </div>
        ),
      )}
    </div>
  );
}