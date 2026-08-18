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
        ink: {
          deep: '#080E15',
          DEFAULT: '#0B1A2A',
          soft: '#14212E',
          raised: '#1B2A3A',
          line: '#243546',
        },
        paper: {
          DEFAULT: '#E8EDF2',
          dim: '#C3CDD8',
        },
        amber: {
          DEFAULT: '#F0A22E',
          dim: '#C77F16',
        },
        teal: {
          DEFAULT: '#3AA0A0',
          dim: '#247070',
        },
        mute: {
          DEFAULT: '#647688',
          light: '#93A3B4',
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
        thread: '48rem',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        flap: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        flap: 'flap 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};