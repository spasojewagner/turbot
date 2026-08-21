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
          // Chat je najtamniji sloj. Bez toga prelaz sa introa zaslepljuje.
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
        eyebrow: '0.16em',
      },

      /**
       * Tri radijusa i krug. Ranije ih je bilo sedam, bez obrazloženja
       * za nijedan — kartica od 2rem pored dugmeta od 0.5rem izgleda kao
       * da pripadaju različitim proizvodima.
       *
       *   control  sitne kontrole, čipovi izvora
       *   panel    dugmad, polja, poruke
       *   surface  kartice i composer
       */
      borderRadius: {
        control: '6px',
        panel: '10px',
        surface: '16px',
      },

      maxWidth: {
        thread: '46rem',
      },

      /**
       * Ugrađene CSS krive su preslabe da bi se osetile.
       * `out` je za ulazak i izlazak, `in-out` za pomeranje po ekranu.
       * `ease-in` se ne koristi na UI-ju: počinje sporo, baš u trenutku
       * kada korisnik gleda.
       */
      transitionTimingFunction: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
      },

      keyframes: {
        /** Ulazak sadržaja. Pomeraj je mali; veći deluje kao skok. */
        enter: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        /** Pokazatelj rada. Samo providnost, bez kretanja. */
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        /** Kursor tokom ispisa. Oštar prelaz, kao pravi karet. */
        caret: {
          '0%, 45%': { opacity: '1' },
          '55%, 100%': { opacity: '0' },
        },
      },

      animation: {
        enter: 'enter 400ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'pulse-soft': 'pulse-soft 1.4s ease-in-out infinite',
        caret: 'caret 1s steps(1, end) infinite',
      },
    },
  },
  plugins: [],
};
