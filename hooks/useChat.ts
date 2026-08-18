import { useCallback, useRef, useState } from 'react';

export interface Source {
  label: string;
  filename: string;
  excerpt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
}

interface ApiResponse {
  text?: string;
  error?: string;
  retryAfter?: number;
  sourceDocuments?: { pageContent: string; metadata?: Record<string, unknown> }[];
  debug?: Record<string, unknown>;
}

const newId = () => Math.random().toString(36).slice(2, 10);

function toSources(input: ApiResponse['sourceDocuments']): Source[] {
  if (!Array.isArray(input)) return [];

  return input.map((doc, i) => ({
    label:
      typeof doc.metadata?.label === 'string' ? doc.metadata.label : `Izvor ${i + 1}`,
    filename:
      typeof doc.metadata?.filename === 'string' ? doc.metadata.filename : '',
    excerpt: doc.pageContent ?? '',
  }));
}

export function useChat({ debug = false }: { debug?: boolean } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Istorija kao parovi [pitanje, odgovor] — format koji API očekuje. */
  const historyRef = useRef<[string, string][]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingRef.current = false;
    setPending(false);
  }, []);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      // Straža protiv dvostrukog slanja: React strict mode montira dvaput,
      // a auto-slanje iz ?q= parametra bi inače krenulo dva puta.
      if (!trimmed || pendingRef.current) return;

      pendingRef.current = true;
      setError(null);
      setPending(true);
      setMessages((prev) => [...prev, { id: newId(), role: 'user', text: trimmed }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed, history: historyRef.current, debug }),
          signal: controller.signal,
        });

        const data: ApiResponse = await response.json().catch(() => ({}));

        if (!response.ok || data.error) {
          setError(data.error ?? `Zahtev nije uspeo (${response.status}).`);
          return;
        }

        const text = data.text ?? '';
        historyRef.current = [...historyRef.current, [trimmed, text]].slice(-6);

        setMessages((prev) => [
          ...prev,
          { id: newId(), role: 'assistant', text, sources: toSources(data.sourceDocuments) },
        ]);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError('Nije moguće povezivanje sa serverom.');
      } finally {
        pendingRef.current = false;
        abortRef.current = null;
        setPending(false);
      }
    },
    [debug],
  );

  const reset = useCallback(() => {
    stop();
    historyRef.current = [];
    setMessages([]);
    setError(null);
  }, [stop]);

  return { messages, pending, error, send, stop, reset, clearError: () => setError(null) };
}