import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `__dirname` ne postoji u ESM kontekstu, a Vite upozorava da će njegova
 * emulacija prestati da radi. `import.meta.url` je zamena koja radi svuda.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts', 'utils/**/*.ts'],
    },
  },
  resolve: {
    // Isti alias kao u tsconfig.json, inače testovi ne nalaze module.
    alias: {
      '@': resolve(here, './'),
    },
  },
});