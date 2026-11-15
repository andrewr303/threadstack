import { builtinEnvironments } from 'vitest/environments';

// Vitest 3/jsdom replaces AbortSignal but retains Node's Request/fetch. Node 26
// enforces their shared realm, and also defines a separate localStorage global.
export default {
  name: 'jsdom',
  transformMode: 'web',
  async setup(global, options) {
    const keys = ['AbortController', 'AbortSignal', 'localStorage'];
    const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(global, key)]));
    // Vitest keys per-file pragma options by the configured environment path.
    const jsdom = options['./tests/environment.mjs'] ?? options.jsdom ?? {};
    const environment = await builtinEnvironments.jsdom.setup(global, { ...options, jsdom });
    for (const key of ['AbortController', 'AbortSignal']) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(global, key, descriptor);
    }
    Object.defineProperty(global, 'localStorage', {
      configurable: true, writable: true, value: global.jsdom.window.localStorage,
    });
    return {
      async teardown() {
        await environment.teardown(global);
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(global, key, descriptor);
          else delete global[key];
        }
      },
    };
  },
};
