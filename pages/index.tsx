import { useRef, useState, useEffect, useCallback } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Message } from '@/types/chat';
import { Document } from 'langchain/document';

// ---------------------------------------------------------------------------
// Tipovi
// ---------------------------------------------------------------------------

type ConnectionStatus = 'checking' | 'connected' | 'error';

interface ChatApiResponse {
  text?: string;
  error?: string;
  friendly?: boolean;
  retryAfter?: number;
  conversationStyle?: string;
  sourceDocuments?: Document[];
  debug?: Record<string, unknown>;
}

interface MessageState {
  messages: Message[];
  history: [string, string][];
  isConnected: boolean;
  lastError?: string;
}

interface Particle {
  left: number;
  top: number;
  delay: number;
  duration: number;
}

const MAX_QUESTION_LENGTH = 600;
const MAX_AUTO_RETRIES = 2;

// ---------------------------------------------------------------------------
// Prezentacione komponente
// ---------------------------------------------------------------------------

const LoadingDots = () => (
  <div className="flex items-center space-x-1">
    <div className="w-2 h-2 bg-white rounded-full animate-bounce" />
    <div
      className="w-2 h-2 bg-white rounded-full animate-bounce"
      style={{ animationDelay: '0.1s' }}
    />
    <div
      className="w-2 h-2 bg-white rounded-full animate-bounce"
      style={{ animationDelay: '0.2s' }}
    />
  </div>
);

type AccordionItemProps = {
  children: React.ReactNode;
};

const AccordionItem = ({ children }: AccordionItemProps) => (
  <div className="border border-gray-200/30 rounded-xl mb-3 overflow-hidden backdrop-blur-sm bg-white/20">
    {children}
  </div>
);

type AccordionTriggerProps = {
  children: React.ReactNode;
  onClick?: () => void;
  isOpen?: boolean;
};

const AccordionTrigger = ({ children, onClick, isOpen }: AccordionTriggerProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-expanded={isOpen}
    className="w-full px-6 py-4 text-left bg-white/10 hover:bg-white/20 transition-all duration-300 flex items-center justify-between backdrop-blur-sm"
  >
    {children}
    <svg
      className={`w-5 h-5 transition-transform duration-300 text-blue-400 ${
        isOpen ? 'rotate-180' : ''
      }`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  </button>
);

type AccordionContentProps = {
  children: React.ReactNode;
  isOpen?: boolean;
};

const AccordionContent = ({ children, isOpen }: AccordionContentProps) => (
  <div
    className={`px-6 py-4 bg-white/5 backdrop-blur-sm transition-all duration-300 ${
      isOpen ? 'block' : 'hidden'
    }`}
  >
    {children}
  </div>
);

const markdownComponents: Components = {
  a: ({ node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" className="underline" />
  ),
  p: ({ node, ...props }) => <p {...props} className="mb-2 last:mb-0" />,
  strong: ({ node, ...props }) => <strong {...props} className="font-semibold" />,
};

/**
 * ISPRAVKA: react-markdown prima tačno jedan string kao dete.
 * Ranije je `{doc.pageContent.substring(0, 500)}...` predavalo dva deteta
 * (izraz i literal "..."), pa je children bio string[] umesto string.
 * Omotač u div nosi prose klase, što radi nezavisno od verzije biblioteke.
 */
const Markdown = ({ children, className }: { children: string; className?: string }) => (
  <div className={className}>
    <ReactMarkdown components={markdownComponents}>{children}</ReactMarkdown>
  </div>
);

// ---------------------------------------------------------------------------
// Glavna komponenta
// ---------------------------------------------------------------------------

export default function TurBotChat() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const [debugMode, setDebugMode] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [openAccordion, setOpenAccordion] = useState<string | null>(null);
  const [showChatInterface, setShowChatInterface] = useState(false);
  const [particles, setParticles] = useState<Particle[]>([]);

  const [messageState, setMessageState] = useState<MessageState>({
    messages: [
      {
        message:
          'Zdravo! Ja sam TurBot, vaš digitalni asistent za turističke aranžmane. Kako mogu da vam pomognem danas? 🌴✈️',
        type: 'apiMessage',
      },
    ],
    history: [],
    isConnected: false,
  });

  const { messages, history } = messageState;
  const messageListRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * ISPRAVKA: retryCount u closure-u je bio zastareo, pa je auto-retry
   * logika donosila odluke na osnovu stare vrednosti. Ref uvek drži
   * aktuelan broj pokušaja.
   */
  const retryCountRef = useRef(0);

  const historyRef = useRef<[string, string][]>([]);
  historyRef.current = history;

  // -------------------------------------------------------------------------
  // Efekti
  // -------------------------------------------------------------------------

  /**
   * ISPRAVKA: čestice su se ranije generisale sa Math.random() tokom
   * rendera. Server i klijent su dobijali različite vrednosti, što je
   * proizvodilo hydration mismatch i upozorenja u konzoli.
   * Sada se generišu tek nakon montiranja, isključivo na klijentu.
   */
  useEffect(() => {
    setParticles(
      Array.from({ length: 20 }, () => ({
        left: Math.random() * 100,
        top: Math.random() * 100,
        delay: Math.random() * 5,
        duration: 3 + Math.random() * 4,
      })),
    );
  }, []);

  const checkApiHealth = useCallback(async () => {
    try {
      setConnectionStatus('checking');

      const response = await fetch('/api/health', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error(`Health check failed: ${response.status}`);

      setConnectionStatus('connected');
      setMessageState((prev) => ({ ...prev, isConnected: true }));
    } catch (err) {
      setConnectionStatus('error');
      setMessageState((prev) => ({
        ...prev,
        isConnected: false,
        lastError: err instanceof Error ? err.message : 'Nepoznata greška',
      }));
    }
  }, []);

  useEffect(() => {
    void checkApiHealth();
  }, [checkApiHealth]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setDebugMode((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // -------------------------------------------------------------------------
  // Obrada grešaka
  // -------------------------------------------------------------------------

  const parseApiError = (input: unknown): string => {
    if (typeof input === 'string') return input;

    if (input && typeof input === 'object') {
      const candidate = input as { error?: string; message?: string };

      if (candidate.error) {
        if (candidate.error.includes('dimension')) {
          return 'Greška u konfiguraciji: neslaganje vektorskih dimenzija. Proverite embedding model.';
        }
        if (candidate.error.includes('Pinecone')) {
          return 'Greška: neuspešna konekcija sa vektorskom bazom.';
        }
        return candidate.error;
      }

      if (candidate.message?.includes('fetch')) {
        return 'Mrežna greška: nije moguće povezivanje sa serverom.';
      }

      if (candidate.message) return candidate.message;
    }

    return 'Došlo je do neočekivane greške.';
  };

  // -------------------------------------------------------------------------
  // Slanje pitanja
  // -------------------------------------------------------------------------

  /**
   * Logika slanja odvojena od event handlera, pa više nema potrebe za
   * lažnim event objektima tipa `{ preventDefault: () => {} }`.
   */
  const sendQuestion = useCallback(
    async (question: string, isRetry = false) => {
      if (!question.trim()) {
        setError('Molimo unesite vaše pitanje.');
        return;
      }

      setError(null);
      setShowChatInterface(true);

      if (!isRetry) {
        setMessageState((state) => ({
          ...state,
          messages: [...state.messages, { type: 'userMessage', message: question }],
        }));
        setQuery('');
      }

      setLoading(true);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            history: historyRef.current,
            debug: debugMode,
          }),
        });

        const data: ChatApiResponse = await response.json().catch(() => ({}));

        if (!response.ok || data.error) {
          throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), {
            payload: data,
            status: response.status,
          });
        }

        setMessageState((state) => ({
          ...state,
          messages: [
            ...state.messages,
            {
              type: 'apiMessage',
              message: data.text ?? 'Nisam dobio odgovor.',
              sourceDocs: data.sourceDocuments ?? [],
            },
          ],
          history: [...state.history, [question, data.text ?? '']],
        }));

        retryCountRef.current = 0;
        setRetryCount(0);
        setConnectionStatus('connected');
      } catch (err: unknown) {
        const payload = (err as { payload?: ChatApiResponse })?.payload;
        setError(parseApiError(payload ?? err));

        const message = err instanceof Error ? err.message : String(err);
        const isTransient =
          message.includes('fetch') ||
          message.includes('timeout') ||
          message.includes('500');

        if (isTransient && retryCountRef.current < MAX_AUTO_RETRIES) {
          retryCountRef.current += 1;
          setRetryCount(retryCountRef.current);

          const backoff = 2000 * retryCountRef.current;
          setTimeout(() => void sendQuestion(question, true), backoff);
          return;
        }

        setConnectionStatus('error');
      } finally {
        setLoading(false);
        setTimeout(() => {
          messageListRef.current?.scrollTo(0, messageListRef.current.scrollHeight);
        }, 100);
      }
    },
    [debugMode],
  );

  const handleSubmit = (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    void sendQuestion(query.trim());
  };

  const handleRetry = () => {
    const lastUserMessage = [...messages].reverse().find((m) => m.type === 'userMessage');
    const question = query.trim() || lastUserMessage?.message;

    if (question) void sendQuestion(question, true);
  };

  const handleEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (query.trim() && !loading) handleSubmit();
    }
  };

  const clearError = () => {
    setError(null);
    retryCountRef.current = 0;
    setRetryCount(0);
  };

  const handleSuggestionClick = (suggestion: string) => {
    setQuery(suggestion);
    setShowChatInterface(true);
    setTimeout(() => textAreaRef.current?.focus(), 100);
  };

  const statusLabel =
    connectionStatus === 'connected'
      ? 'Sistem aktivan'
      : connectionStatus === 'error'
        ? 'Greška konekcije'
        : 'Proverava se...';

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute top-20 left-10 w-96 h-96 bg-gradient-to-r from-blue-500/20 to-purple-500/20 rounded-full mix-blend-multiply filter blur-3xl animate-pulse" />
        <div
          className="absolute top-40 right-10 w-96 h-96 bg-gradient-to-r from-purple-500/20 to-pink-500/20 rounded-full mix-blend-multiply filter blur-3xl animate-pulse"
          style={{ animationDelay: '2s' }}
        />
        <div
          className="absolute -bottom-20 left-1/2 w-96 h-96 bg-gradient-to-r from-teal-500/20 to-blue-500/20 rounded-full mix-blend-multiply filter blur-3xl animate-pulse"
          style={{ animationDelay: '4s' }}
        />

        <div className="absolute inset-0">
          {particles.map((particle, i) => (
            <div
              key={i}
              className="absolute w-2 h-2 bg-white/20 rounded-full animate-pulse"
              style={{
                left: `${particle.left}%`,
                top: `${particle.top}%`,
                animationDelay: `${particle.delay}s`,
                animationDuration: `${particle.duration}s`,
              }}
            />
          ))}
        </div>
      </div>

      <div className="relative z-10">
        {!showChatInterface ? (
          <div className="min-h-screen flex items-center justify-center px-4">
            <div className="max-w-6xl mx-auto text-center">
              <div className="mb-16">
                <div className="flex items-center justify-center mb-8">
                  <div className="relative">
                    <div className="text-8xl font-black bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600 bg-clip-text text-transparent filter drop-shadow-2xl">
                      TurBot
                    </div>
                    <div className="absolute -top-4 -right-4 w-8 h-8 bg-gradient-to-r from-green-400 to-emerald-500 rounded-full animate-ping shadow-2xl" />
                    <div className="absolute -top-2 -right-2 w-4 h-4 bg-green-400 rounded-full shadow-lg" />
                  </div>
                </div>

                <div className="text-6xl mb-8" aria-hidden="true">
                  <span className="inline-block animate-pulse">🌴</span>
                  <span className="inline-block animate-pulse" style={{ animationDelay: '0.5s' }}>
                    ✈️
                  </span>
                  <span className="inline-block animate-pulse" style={{ animationDelay: '1s' }}>
                    🏖️
                  </span>
                  <span className="inline-block animate-pulse" style={{ animationDelay: '1.5s' }}>
                    🌊
                  </span>
                </div>

                <h2 className="text-3xl md:text-4xl font-bold text-white mb-6 leading-tight">
                  Vaš{' '}
                  <span className="bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent">
                    Premium
                  </span>{' '}
                  AI Asistent
                </h2>
                <h3 className="text-xl md:text-2xl text-gray-300 mb-8 font-light">
                  za Turističke Aranžmane
                </h3>

                <p className="text-lg text-gray-400 max-w-2xl mx-auto leading-relaxed">
                  Otkrijte savršene destinacije uz pomoć napredne veštačke inteligencije.
                  Personalizovani aranžmani, trenutne cene i ekskluzivne ponude.
                </p>
              </div>

              <div className="grid md:grid-cols-3 gap-8 mb-16">
                {[
                  {
                    icon: '🎯',
                    title: 'Personalizovano',
                    description: 'AI analizira vaše potrebe i preporučuje idealne aranžmane',
                    gradient: 'from-blue-500 to-cyan-500',
                  },
                  {
                    icon: '⚡',
                    title: 'Trenutno',
                    description: 'Realtime cene i dostupnost iz svih vodećih agencija',
                    gradient: 'from-purple-500 to-pink-500',
                  },
                  {
                    icon: '💎',
                    title: 'Ekskluzivno',
                    description: 'Pristup skrivenim ponudama i ekskluzivnim popustima',
                    gradient: 'from-emerald-500 to-teal-500',
                  },
                ].map((feature) => (
                  <div key={feature.title} className="group">
                    <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20 hover:bg-white/20 transition-all duration-500 transform hover:scale-105 shadow-2xl">
                      <div className="text-4xl mb-4">{feature.icon}</div>
                      <h4
                        className={`text-xl font-bold mb-3 bg-gradient-to-r ${feature.gradient} bg-clip-text text-transparent`}
                      >
                        {feature.title}
                      </h4>
                      <p className="text-gray-300 text-sm leading-relaxed">
                        {feature.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 backdrop-blur-xl rounded-3xl p-12 border border-white/20 shadow-2xl mb-16">
                <h3 className="text-3xl font-bold text-white mb-6">Započnite Vaše Putovanje</h3>
                <p className="text-gray-300 mb-8 max-w-2xl mx-auto">
                  Postavite pitanje i otkrijte najbolje turističke ponude prilagođene vašem budžetu
                  i željama
                </p>

                <div className="max-w-2xl mx-auto">
                  <div className="relative">
                    <label htmlFor="hero-question" className="sr-only">
                      Vaše pitanje
                    </label>
                    <textarea
                      id="hero-question"
                      ref={textAreaRef}
                      disabled={loading}
                      onKeyDown={handleEnter}
                      rows={3}
                      maxLength={MAX_QUESTION_LENGTH}
                      placeholder="Npr: Kakve ponude imate za Grčku u junu za porodicu sa dvoje dece?"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="w-full px-6 py-4 pr-16 rounded-2xl border-2 border-white/20 bg-white/10 backdrop-blur-sm text-white placeholder-gray-300 transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-blue-500/50 focus:border-blue-400 resize-none text-lg"
                    />
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={loading || !query.trim()}
                      aria-label="Pošalji pitanje"
                      className="absolute right-3 top-3 w-12 h-12 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 shadow-lg transition-all duration-300 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {loading ? (
                        <LoadingDots />
                      ) : (
                        <svg
                          className="w-6 h-6 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                          />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div className="max-w-4xl mx-auto">
                <h4 className="text-xl font-semibold text-white mb-6">Popularna Pitanja</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { text: 'Letovanje u Grčkoj', emoji: '🇬🇷', color: 'from-blue-500 to-cyan-500' },
                    { text: 'All Inclusive Turska', emoji: '🇹🇷', color: 'from-red-500 to-orange-500' },
                    { text: 'Egipat - last minute', emoji: '🏺', color: 'from-yellow-500 to-orange-500' },
                    { text: 'Budžet do 1000€', emoji: '💰', color: 'from-green-500 to-emerald-500' },
                    { text: 'Mediteran - avgust', emoji: '🌊', color: 'from-teal-500 to-blue-500' },
                    { text: 'Porodični odmor', emoji: '👨‍👩‍👧‍👦', color: 'from-purple-500 to-pink-500' },
                    { text: 'Romantični izlet', emoji: '💕', color: 'from-pink-500 to-rose-500' },
                    { text: 'Avantura i sport', emoji: '🏄', color: 'from-indigo-500 to-purple-500' },
                  ].map((suggestion) => (
                    <button
                      key={suggestion.text}
                      type="button"
                      onClick={() => handleSuggestionClick(suggestion.text)}
                      className={`group relative bg-gradient-to-r ${suggestion.color} rounded-xl p-4 text-white font-medium hover:shadow-2xl transition-all duration-300 overflow-hidden`}
                    >
                      <div className="absolute inset-0 bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                      <div className="relative z-10 flex items-center justify-center gap-2">
                        <span className="text-lg" aria-hidden="true">
                          {suggestion.emoji}
                        </span>
                        <span className="text-sm font-semibold">{suggestion.text}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-16 flex items-center justify-center gap-4">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      connectionStatus === 'connected'
                        ? 'bg-green-400'
                        : connectionStatus === 'error'
                          ? 'bg-red-400'
                          : 'bg-yellow-400 animate-pulse'
                    }`}
                  />
                  <span className="text-gray-300 text-sm">{statusLabel}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-screen px-4 py-8">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-8">
                <button
                  type="button"
                  onClick={() => setShowChatInterface(false)}
                  className="mb-6 px-6 py-3 bg-white/10 backdrop-blur-sm rounded-xl text-white hover:bg-white/20 transition-all duration-300 flex items-center gap-2 mx-auto"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 19l-7-7m0 0l7-7m-7 7h18"
                    />
                  </svg>
                  Nazad na početnu
                </button>

                <h1 className="text-4xl font-bold bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600 bg-clip-text text-transparent">
                  TurBot Chat
                </h1>
              </div>

              {debugMode && (
                <div className="bg-gray-900/90 backdrop-blur-sm text-green-400 p-6 rounded-xl border border-gray-700/50 mb-6 font-mono text-sm">
                  <h3 className="text-green-300 font-bold mb-3">Debug Console</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      Status: <span className="text-yellow-400">{connectionStatus}</span>
                    </div>
                    <div>
                      Retry: <span className="text-blue-400">{retryCount}</span>
                    </div>
                    <div>
                      Messages: <span className="text-purple-400">{messages.length}</span>
                    </div>
                    <div>
                      History: <span className="text-pink-400">{history.length}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void checkApiHealth()}
                    className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors duration-200"
                  >
                    Test Connection
                  </button>
                </div>
              )}

              <div className="bg-white/10 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/20 overflow-hidden">
                <div
                  ref={messageListRef}
                  role="log"
                  aria-live="polite"
                  aria-label="Istorija razgovora"
                  className="h-96 overflow-y-auto p-6 space-y-6 bg-gradient-to-b from-black/20 to-black/40"
                >
                  {messages.map((message, index) => (
                    <div key={`chatMessage-${index}`} className="space-y-4">
                      <div
                        className={`flex items-start gap-4 ${
                          message.type === 'userMessage' ? 'justify-end' : 'justify-start'
                        }`}
                      >
                        {message.type === 'apiMessage' && (
                          <div className="flex-shrink-0">
                            <div
                              className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center text-white font-bold shadow-2xl"
                              aria-hidden="true"
                            >
                              🤖
                            </div>
                          </div>
                        )}

                        <div
                          className={`max-w-xs lg:max-w-md xl:max-w-lg ${
                            message.type === 'userMessage'
                              ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-2xl rounded-tr-md shadow-2xl'
                              : 'bg-white/90 text-gray-800 rounded-2xl rounded-tl-md border border-white/30 shadow-2xl backdrop-blur-sm'
                          } px-6 py-4`}
                        >
                          <Markdown className="prose prose-sm max-w-none">
                            {message.message}
                          </Markdown>
                        </div>

                        {message.type === 'userMessage' && (
                          <div className="flex-shrink-0">
                            <div
                              className="w-12 h-12 bg-gradient-to-br from-gray-400 to-gray-600 rounded-2xl flex items-center justify-center text-white font-bold shadow-2xl"
                              aria-hidden="true"
                            >
                              👤
                            </div>
                          </div>
                        )}
                      </div>

                      {message.sourceDocs && message.sourceDocs.length > 0 && (
                        <div className="ml-16 space-y-3">
                          {message.sourceDocs.map((doc, docIndex) => {
                            const key = `item-${index}-${docIndex}`;
                            const isOpen = openAccordion === key;

                            return (
                              <AccordionItem key={key}>
                                <AccordionTrigger
                                  isOpen={isOpen}
                                  onClick={() => setOpenAccordion(isOpen ? null : key)}
                                >
                                  <div className="flex items-center gap-3">
                                    <span className="text-2xl" aria-hidden="true">
                                      📋
                                    </span>
                                    <span className="font-semibold text-white">
                                      Aranžman {docIndex + 1}
                                    </span>
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent isOpen={isOpen}>
                                  <Markdown className="prose prose-sm max-w-none text-gray-200">
                                    {`${doc.pageContent.substring(0, 500)}...`}
                                  </Markdown>
                                </AccordionContent>
                              </AccordionItem>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}

                  {loading && (
                    <div className="flex justify-start">
                      <div className="flex items-start gap-4">
                        <div className="flex-shrink-0">
                          <div
                            className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center text-white font-bold shadow-2xl"
                            aria-hidden="true"
                          >
                            🤖
                          </div>
                        </div>
                        <div className="bg-white/90 text-gray-800 rounded-2xl rounded-tl-md border border-white/30 shadow-2xl backdrop-blur-sm px-6 py-4">
                          <div className="flex items-center gap-3">
                            <LoadingDots />
                            <span className="text-gray-600">TurBot razmišlja...</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {error && (
                  <div
                    role="alert"
                    className="mx-6 mb-4 bg-red-500/20 border border-red-500/50 backdrop-blur-sm text-red-100 p-4 rounded-xl relative"
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl" aria-hidden="true">
                        ⚠️
                      </span>
                      <div className="flex-1">
                        <h4 className="font-semibold mb-1">Greška</h4>
                        <p className="text-sm leading-relaxed">{error}</p>
                      </div>
                      <button
                        type="button"
                        onClick={clearError}
                        aria-label="Zatvori poruku o grešci"
                        className="text-red-200 hover:text-white transition-colors duration-200"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>

                    <div className="mt-3 pt-3 border-t border-red-400/30">
                      <button
                        type="button"
                        onClick={handleRetry}
                        disabled={loading}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors duration-200 text-sm font-medium disabled:opacity-50"
                      >
                        Pokušaj ponovo
                        {retryCount > 0 && ` (${retryCount}/${MAX_AUTO_RETRIES})`}
                      </button>
                    </div>
                  </div>
                )}

                <div className="p-6 border-t border-white/20 bg-black/30 backdrop-blur-sm">
                  <div className="relative">
                    <label htmlFor="chat-question" className="sr-only">
                      Vaše pitanje
                    </label>
                    <textarea
                      id="chat-question"
                      ref={textAreaRef}
                      disabled={loading}
                      onKeyDown={handleEnter}
                      rows={3}
                      maxLength={MAX_QUESTION_LENGTH}
                      placeholder="Postavite pitanje o turističkim aranžmanima..."
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="w-full px-6 py-4 pr-24 rounded-2xl border-2 border-white/20 bg-white/10 backdrop-blur-sm text-white placeholder-gray-300 transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-blue-500/50 focus:border-blue-400 resize-none"
                    />
                    <div className="absolute right-3 top-3 flex items-center gap-2">
                      {query.length > MAX_QUESTION_LENGTH * 0.8 && (
                        <div className="text-xs text-gray-400 mr-2">
                          {query.length}/{MAX_QUESTION_LENGTH}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={loading || !query.trim()}
                        aria-label="Pošalji pitanje"
                        className="w-12 h-12 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 shadow-2xl transition-all duration-300 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loading ? (
                          <LoadingDots />
                        ) : (
                          <svg
                            className="w-6 h-6 text-white"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                            />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-4">
                    <div className="flex items-center gap-2 text-sm text-gray-400">
                      <kbd className="px-2 py-1 bg-white/10 rounded text-xs">Enter</kbd>
                      <span>za slanje</span>
                      <kbd className="px-2 py-1 bg-white/10 rounded text-xs">Shift+Enter</kbd>
                      <span>novi red</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        disabled={loading || !query}
                        className="px-4 py-2 text-sm text-gray-300 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg transition-all duration-200 disabled:opacity-50"
                      >
                        Obriši
                      </button>

                      <button
                        type="button"
                        onClick={() => void checkApiHealth()}
                        disabled={loading}
                        className={`px-4 py-2 text-sm rounded-lg transition-all duration-200 disabled:opacity-50 ${
                          connectionStatus === 'connected'
                            ? 'text-green-300 bg-green-500/20 hover:bg-green-500/30'
                            : connectionStatus === 'error'
                              ? 'text-red-300 bg-red-500/20 hover:bg-red-500/30'
                              : 'text-yellow-300 bg-yellow-500/20 hover:bg-yellow-500/30'
                        }`}
                      >
                        Status
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-gradient-to-br from-blue-500/20 to-cyan-500/20 backdrop-blur-sm rounded-2xl p-6 border border-white/20 shadow-xl">
                  <h3 className="text-lg font-semibold text-white mb-3">Saveti</h3>
                  <ul className="text-sm text-gray-300 space-y-2">
                    <li>Navedite željenu destinaciju</li>
                    <li>Spomenite period putovanja</li>
                    <li>Ukažite na budžet</li>
                    <li>Navedite broj osoba</li>
                  </ul>
                </div>

                <div className="bg-gradient-to-br from-purple-500/20 to-pink-500/20 backdrop-blur-sm rounded-2xl p-6 border border-white/20 shadow-xl">
                  <h3 className="text-lg font-semibold text-white mb-3">Popularne Destinacije</h3>
                  <div className="flex flex-wrap gap-2">
                    {['Grčka', 'Turska', 'Egipat', 'Španija', 'Italija'].map((dest) => (
                      <button
                        key={dest}
                        type="button"
                        onClick={() => handleSuggestionClick(`Ponude za ${dest}`)}
                        className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg text-sm text-white transition-all duration-200"
                      >
                        {dest}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-gradient-to-br from-emerald-500/20 to-teal-500/20 backdrop-blur-sm rounded-2xl p-6 border border-white/20 shadow-xl">
                  <h3 className="text-lg font-semibold text-white mb-3">Podrška</h3>
                  <p className="text-sm text-gray-300 mb-4">Potrebna vam je pomoć?</p>
                  <button
                    type="button"
                    className="w-full px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors duration-200 text-sm font-medium"
                  >
                    Kontaktiraj nas
                  </button>
                </div>
              </div>

              <div className="mt-12 text-center">
                <div className="text-gray-400 text-sm mb-4">
                  Powered by AI • Realtime Data • Secure Connection
                </div>
                <div className="flex items-center justify-center gap-6 text-xs text-gray-500">
                  <span>© 2026 TurBot</span>
                  <span>•</span>
                  <span>Privatnost</span>
                  <span>•</span>
                  <span>Uslovi</span>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    v2.1.0
                    {debugMode && <span className="text-green-400">DEBUG</span>}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {process.env.NODE_ENV === 'development' && (
        <div className="fixed bottom-4 left-4 text-xs text-gray-500 bg-black/50 backdrop-blur-sm px-3 py-2 rounded-lg">
          Ctrl+Shift+D za debug mod
        </div>
      )}
    </div>
  );
}