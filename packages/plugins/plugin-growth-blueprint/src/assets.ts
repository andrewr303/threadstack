// Reads the skill and agent instruction files that ship with the package.
// Paths resolve from this module's URL, which works both from `src/` (tests)
// and from the bundled `dist/manifest.js`.

import { readdirSync, readFileSync, statSync } from "node:fs";

/** Host limits from the managed-skill manifest validator. */
export const MAX_SKILL_FILES = 50;
export const MAX_SKILL_FILE_CHARS = 200_000;

/** Text files that can ship inside the managed skill folder. */
const SKILL_FILE_EXTENSIONS = new Set([
  ".md", ".py", ".html", ".htm", ".json", ".txt", ".css", ".js", ".mjs", ".yaml", ".yml", ".csv", ".svg", ".toml", ".sh",
]);

/**
 * Names skipped anywhere in the skill tree. The lead can extend this list when
 * the vendored rea-growth snapshot carries files that should not install.
 */
export const SKILL_FILE_EXCLUDES = new Set([
  ".DS_Store",
  "__pycache__",
  ".pytest_cache",
  "node_modules",
  "tests",
  "examples",
  ".git",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function walkTextFiles(root: URL, accept: (relativePath: string, name: string) => boolean): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  function walk(relativeDir: string) {
    const dirUrl = new URL(relativeDir ? `${relativeDir}/` : "./", root);
    let entries: string[];
    try {
      entries = readdirSync(dirUrl);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (SKILL_FILE_EXCLUDES.has(entry)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
      const stat = statSync(new URL(relativePath, root));
      if (stat.isDirectory()) {
        walk(relativePath);
      } else if (stat.isFile() && accept(relativePath, entry)) {
        out.push({ path: relativePath, content: readFileSync(new URL(relativePath, root), "utf8") });
      }
    }
  }
  walk("");
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

const SKILL_ROOT = new URL("../skills/growth-blueprint/", import.meta.url);
const AGENT_ROOT = new URL("../agents/growth/", import.meta.url);

export function growthSkillMarkdown(): string {
  return readFileSync(new URL("SKILL.md", SKILL_ROOT), "utf8");
}

/**
 * Every text file under `skills/growth-blueprint/` except the root SKILL.md,
 * including the vendored `rea-growth/` snapshot (SKILL.md, scripts/, assets/,
 * references/). Collected when the manifest loads, so files the lead adds to
 * the folder ship without a code change.
 */
export function growthSkillFiles(): Array<{ path: string; content: string }> {
  return walkTextFiles(SKILL_ROOT, (relativePath, name) =>
    relativePath.toLowerCase() !== "skill.md" && SKILL_FILE_EXTENSIONS.has(extensionOf(name)),
  );
}

export function growthAgentInstructionFiles(): Record<string, string> {
  return Object.fromEntries(walkTextFiles(AGENT_ROOT, () => true).map((file) => [file.path, file.content]));
}
