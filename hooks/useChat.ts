import { useCallback, useRef, useState } from 'react';

export interface Source {
  label: string;
  filename: string;
  excerpt: string;
  score?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
  /** Poruka koja se još ispisuje — koristi se za kursor u UI-ju. */
  streaming?: boolean;
}

export type Stage = 'razumevanje' | 'pretraga' | 'sastavljanje';

type StreamEvent =
  | { type: 'status'; stage: Stage }
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | { type: 'done'; debug?: Record<string, unknown> }
  | { type: 'error'; message: string };

const MAX_HISTORY_TURNS = 12;

const newId = () => Math.random().toString(36).slice(2, 10);

export function useChat({ debug = false }: { debug?: boolean } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const historyRef = useRef<[string, string][]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingRef.current = false;
    setPending(false);
    setStage(null);
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
  }, []);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      // Straža protiv dvostrukog slanja: strict mode montira dvaput, pa bi
      // auto-slanje iz ?q= parametra inače krenulo dva puta.
      if (!trimmed || pendingRef.current) return;

      pendingRef.current = true;
      setError(null);
      setPending(true);
      setStage('razumevanje');

      const answerId = newId();

      setMessages((prev) => [
        ...prev,
        { id: newId(), role: 'user', text: trimmed },
        { id: answerId, role: 'assistant', text: '', streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      /** Akumulira se lokalno da bi na kraju ušlo u istoriju. */
      let answerText = '';

      const patch = (update: Partial<ChatMessage>) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === answerId ? { ...m, ...update } : m)),
        );
      };

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed, history: historyRef.current, debug }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => ({}));
          setError(data.error ?? `Zahtev nije uspeo (${response.status}).`);
          setMessages((prev) => prev.filter((m) => m.id !== answerId));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        /** Ostatak reda koji je stigao presečen između dva chunka. */
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;

            let event: StreamEvent;
            try {
              event = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }

            switch (event.type) {
              case 'status':
                setStage(event.stage);
                break;

              case 'sources':
                patch({ sources: event.sources });
                break;

              case 'token':
                answerText += event.text;
                patch({ text: answerText });
                break;

              case 'done':
                if (debug && event.debug) console.log('[debug]', event.debug);
                break;

              case 'error':
                setError(event.message);
                break;
            }
          }
        }

        patch({ streaming: false });

        if (answerText) {
          const turn: [string, string] = [trimmed, answerText];
          historyRef.current = [...historyRef.current, turn].slice(-MAX_HISTORY_TURNS);
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== answerId));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Prekid je namerna radnja korisnika — zadržavamo ono što je stiglo.
          patch({ streaming: false });
          if (answerText) {
            const turn: [string, string] = [trimmed, answerText];
            historyRef.current = [...historyRef.current, turn].slice(-MAX_HISTORY_TURNS);
          }
          return;
        }

        setError('Nije moguće povezivanje sa serverom.');
        setMessages((prev) => prev.filter((m) => m.id !== answerId));
      } finally {
        pendingRef.current = false;
        abortRef.current = null;
        setPending(false);
        setStage(null);
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

  return {
    messages,
    pending,
    stage,
    error,
    send,
    stop,
    reset,
    clearError: () => setError(null),
  };
}