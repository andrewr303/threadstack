#!/usr/bin/env node
// Re-vendor the rea-growth playbook into skills/growth-blueprint/rea-growth/ and record each
// file's SHA-256 in VENDOR.json. tests/contracts.test.ts fails when a vendored file no longer
// matches its recorded hash, so a hand edit or a partial copy cannot ship unnoticed.
//
//   node scripts/sync-rea-growth.mjs --from <path to a rea-growth checkout>
//   REA_GROWTH_DIR=<path> node scripts/sync-rea-growth.mjs
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = resolve(here, "../skills/growth-blueprint/rea-growth");
const argIndex = process.argv.indexOf("--from");
const source = argIndex > 0 ? process.argv[argIndex + 1] : process.env.REA_GROWTH_DIR;
if (!source || !existsSync(join(source, "SKILL.md"))) {
  console.error("usage: sync-rea-growth.mjs --from <rea-growth checkout> (or set REA_GROWTH_DIR)");
  process.exit(2);
}

// Only what an agent run needs: the playbook, its scripts, the page template and the references.
const files = ["SKILL.md", "assets/blueprint.template.html"];
for (const dir of ["scripts", "references"]) {
  for (const name of readdirSync(join(source, dir)).sort()) {
    if ((dir === "scripts" && name.endsWith(".py")) || (dir === "references" && name.endsWith(".md"))) {
      files.push(`${dir}/${name}`);
    }
  }
}

rmSync(dest, { recursive: true, force: true });
const hashes = {};
for (const rel of files) {
  const to = join(dest, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(source, rel), to);
  hashes[rel] = createHash("sha256").update(readFileSync(to)).digest("hex");
}
writeFileSync(join(dest, "VENDOR.json"), `${JSON.stringify({ source: "rea-growth", files: hashes }, null, 2)}\n`);
console.log(`vendored ${files.length} files into ${dest}`);
