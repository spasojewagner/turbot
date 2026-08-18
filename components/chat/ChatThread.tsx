import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

import type { ChatMessage, Source } from '@/hooks/useChat';

/**
 * Markdown se stilizuje ručno jer @tailwindcss/typography nije instaliran,
 * a odgovori su gotovo uvek ugnježdene liste sa cenama i datumima.
 * Brojevi i valute idu u mono — to je tabelarni podatak, ne proza.
 */
const markdown: Components = {
  p: ({ node, ...props }) => <p {...props} className="mb-3 last:mb-0 leading-relaxed" />,
  ul: ({ node, ...props }) => (
    <ul {...props} className="mb-3 ml-1 space-y-1.5 last:mb-0" />
  ),
  ol: ({ node, ...props }) => (
    <ol {...props} className="mb-3 ml-1 list-none space-y-3 last:mb-0" />
  ),
  li: ({ node, ...props }) => (
    <li
      {...props}
      className="relative pl-4 leading-relaxed before:absolute before:left-0 before:top-[0.6em] before:h-1 before:w-1 before:rounded-full before:bg-teal/60"
    />
  ),
  strong: ({ node, ...props }) => (
    <strong {...props} className="font-medium text-ink" />
  ),
  code: ({ node, ...props }) => (
    <code {...props} className="rounded bg-paper px-1 font-mono text-[0.9em]" />
  ),
  a: ({ node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" className="text-teal underline" />
  ),
  h1: ({ node, ...props }) => (
    <h3 {...props} className="mb-2 font-display text-base font-medium" />
  ),
  h2: ({ node, ...props }) => (
    <h3 {...props} className="mb-2 font-display text-base font-medium" />
  ),
  h3: ({ node, ...props }) => (
    <h3 {...props} className="mb-2 font-display text-base font-medium" />
  ),
};

function SourceList({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<number | null>(null);

  if (!sources.length) return null;

  return (
    <div className="mt-5 border-t border-paper-line pt-4">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-eyebrow text-mute">
        izvori ({sources.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((source, i) => (
          <button
            key={`${source.filename}-${i}`}
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
            className={`rounded-md border px-2.5 py-1 text-left font-mono text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal ${
              open === i
                ? 'border-teal bg-teal/10 text-teal-dim'
                : 'border-paper-line text-mute hover:border-mute-light hover:text-ink'
            }`}
          >
            <span className="text-amber-dim">{i + 1}</span>
            <span className="ml-1.5">{source.label}</span>
          </button>
        ))}
      </div>

      {open !== null && (
        <div className="mt-3 rounded-lg border border-paper-line bg-paper p-3">
          <p className="mb-2 break-all font-mono text-[11px] text-mute">
            {sources[open].filename}
          </p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-mute">
            {sources[open].excerpt}
          </p>
        </div>
      )}
    </div>
  );
}

export default function ChatThread({
  messages,
  pending,
}: {
  messages: ChatMessage[];
  pending: boolean;
}) {
  return (
    <div className="space-y-8">
      {messages.map((message) =>
        message.role === 'user' ? (
          <div key={message.id} className="flex justify-end">
            <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-paper">
              {message.text}
            </p>
          </div>
        ) : (
          /* Asistent bez bubble-a — strukturirane liste se čitaju punom širinom. */
          <div key={message.id} className="text-ink">
            <ReactMarkdown components={markdown}>{message.text}</ReactMarkdown>
            <SourceList sources={message.sources ?? []} />
          </div>
        ),
      )}

      {pending && (
        <div className="flex items-center gap-2 font-mono text-xs text-mute">
          <span className="h-1.5 w-1.5 animate-flap rounded-full bg-amber" />
          pretražujem cenovnike
        </div>
      )}
    </div>
  );
}