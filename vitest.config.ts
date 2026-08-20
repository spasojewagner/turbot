import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

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
      '@': resolve(__dirname, './'),
    },
  },
});
