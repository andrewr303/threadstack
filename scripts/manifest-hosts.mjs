// Derives manifest match patterns from the provider registry so the manifest,
// content-script matches and DOM adapters can never drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function captureMatchPatterns() {
  const source = fs.readFileSync(path.join(__dirname, '../src/core/providers.ts'), 'utf8');
  const patterns = new Set();
  for (const block of source.matchAll(/matchPatterns:\s*\[([^\]]*)\]/g)) {
    for (const m of block[1].matchAll(/'([^']+)'/g)) patterns.add(m[1]);
  }
  if (patterns.size === 0) throw new Error('No provider match patterns found in providers.ts');
  return [...patterns];
}
