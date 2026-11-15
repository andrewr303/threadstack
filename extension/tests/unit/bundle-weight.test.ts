// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

// Scripts injected into web pages run on every matching page and frame, so what they pull in
// matters. A single careless import (for example of schema.ts, which reaches the validation
// library) once grew the page-world script from 3 KB to 479 KB without any test noticing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function bundle(entry: string, minify: boolean) {
  const result = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    write: false,
    metafile: true,
    minify,
    logLevel: 'silent',
  });
  const output = Object.values(result.metafile.outputs)[0];
  return { bytes: output.bytes, inputs: Object.keys(output.inputs) };
}

describe('injected script bundles', () => {
  const PAGE_WORLD: Array<[string, number]> = [
    ['src/entrypoints/site-data-main.ts', 8_000],
    ['src/entrypoints/grok-x-main.ts', 8_000],
    ['src/entrypoints/embed-cookie-main.ts', 8_000],
    ['src/entrypoints/embed-bridge.ts', 8_000],
  ];

  it.each(PAGE_WORLD)('%s stays small and free of libraries', async (entry, limit) => {
    const built = await bundle(entry, true);
    expect(built.inputs.filter((f) => f.includes('node_modules'))).toEqual([]);
    expect(built.bytes).toBeLessThan(limit);
  });

  it('the capture content script does not carry the validation library or the database', async () => {
    const built = await bundle('src/entrypoints/content.ts', false);
    expect(built.inputs.filter((f) => /node_modules\/(zod|dexie|react|@anthropic-ai)\//.test(f))).toEqual([]);
    expect(built.bytes).toBeLessThan(260_000);
  });
});
