/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './hooks/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Noćno nebo na visini — landing.
        ink: {
          DEFAULT: '#0B1A2A',
          soft: '#14293D',
          line: '#1F3A52',
        },
        // Hladan papir — chat površina, za dugačke cenovnike.
        paper: {
          DEFAULT: '#F2F4F6',
          card: '#FFFFFF',
          line: '#E2E6EA',
        },
        // Amber sa split-flap tablice. Jedini akcent.
        amber: {
          DEFAULT: '#F0A22E',
          dim: '#B87817',
        },
        teal: {
          DEFAULT: '#2E8C8C',
          dim: '#1F6363',
        },
        mute: {
          DEFAULT: '#64748B',
          light: '#94A3B8',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        eyebrow: '0.18em',
      },
      maxWidth: {
        thread: '46rem',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        flap: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        flap: 'flap 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
