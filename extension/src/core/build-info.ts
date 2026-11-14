/**
 * Build identity stamped into every bundle by scripts/build-extension.mjs and
 * into manifest.json as `version_name`. Comparing the two at runtime tells us
 * whether the browser is still running a previous build's manifest: Chrome and
 * Edge read manifest.json only when an unpacked extension is (re)loaded, so a
 * rebuild without pressing Reload leaves the old manifest live.
 */
export interface BuildInfo {
  version: string;
  /** Exactly the manifest `version_name` this build wrote. */
  versionName: string;
  buildId: string;
  builtAt: string;
}

declare const __TK_BUILD__: BuildInfo | undefined;

const UNBUNDLED: BuildInfo = {
  version: '0.0.0',
  versionName: '0.0.0 (unbundled)',
  buildId: 'unbundled',
  builtAt: '1970-01-01T00:00:00.000Z',
};

export const BUILD_INFO: BuildInfo = typeof __TK_BUILD__ !== 'undefined' && __TK_BUILD__ ? __TK_BUILD__ : UNBUNDLED;
