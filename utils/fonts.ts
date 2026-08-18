import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google';

/**
 * Tri fonta sa razdvojenim ulogama.
 *
 * next/font self-hostuje fajlove u build fazi, pa nema poziva ka
 * fonts.googleapis.com u runtime-u — što je usput rešilo i one
 * `Client network socket disconnected` greške u dev serveru.
 */

export const fontDisplay = Space_Grotesk({
  subsets: ['latin', 'latin-ext'],
  weight: ['500', '700'],
  variable: '--font-display',
  display: 'swap',
});

export const fontBody = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-body',
  display: 'swap',
});

/** Za brojeve letova, cene, datume — sve što je tabelarni podatak. */
export const fontMono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const fontVariables = [
  fontDisplay.variable,
  fontBody.variable,
  fontMono.variable,
].join(' ');