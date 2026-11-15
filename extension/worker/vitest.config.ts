import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: {
    zod: fileURLToPath(new URL('./node_modules/zod/index.js', import.meta.url)),
    'cloudflare:workers': fileURLToPath(new URL('./tests/runtime.ts', import.meta.url)),
  } },
  test: { include: ['tests/**/*.test.ts'], restoreMocks: true },
});
