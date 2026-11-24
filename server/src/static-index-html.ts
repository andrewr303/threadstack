import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";

/** Runtime data only: no inline executable code, keys, or wildcard extension origins. */
export function applyThreadStackHostConfig(html: string, env: NodeJS.ProcessEnv = process.env): string {
  // PAPERCLIP_THREADKEEPER_EXTENSION_IDS is the name from before the ThreadStack rename. Helpers installed
  // earlier still export it, so both names are read and their IDs combined.
  const configured = [env.PAPERCLIP_THREADSTACK_EXTENSION_IDS, env.PAPERCLIP_THREADKEEPER_EXTENSION_IDS].filter(Boolean).join(",");
  const ids = [...new Set(configured.split(/[\s,]+/).filter((id) => /^[a-p]{32}$/.test(id)))];
  const meta = `<meta name="paperclip-threadstack-extension-ids" content="${ids.join(",")}">`;
  // Any copy already in the page, under the current or the pre-rename name, is replaced by the server's own.
  const clean = html.replace(/<meta\b[^>]*\bname\s*=\s*["']paperclip-thread(?:stack|keeper)-extension-ids["'][^>]*>/gi, "");
  return /<head\b[^>]*>/i.test(clean) ? clean.replace(/<head\b[^>]*>/i, (head) => `${head}${meta}`) : `${meta}${clean}`;
}

export function readBrandedStaticIndexHtml(uiDist: string): string {
  return applyThreadStackHostConfig(applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8")));
}
