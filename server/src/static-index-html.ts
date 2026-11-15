import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";

/** Runtime data only: no inline executable code, keys, or wildcard extension origins. */
export function applyThreadkeeperHostConfig(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const ids = [...new Set((env.PAPERCLIP_THREADKEEPER_EXTENSION_IDS ?? "").split(/[\s,]+/).filter((id) => /^[a-p]{32}$/.test(id)))];
  const meta = `<meta name="paperclip-threadkeeper-extension-ids" content="${ids.join(",")}">`;
  const clean = html.replace(/<meta\b[^>]*\bname\s*=\s*["']paperclip-threadkeeper-extension-ids["'][^>]*>/gi, "");
  return /<head\b[^>]*>/i.test(clean) ? clean.replace(/<head\b[^>]*>/i, (head) => `${head}${meta}`) : `${meta}${clean}`;
}

export function readBrandedStaticIndexHtml(uiDist: string): string {
  return applyThreadkeeperHostConfig(applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8")));
}
