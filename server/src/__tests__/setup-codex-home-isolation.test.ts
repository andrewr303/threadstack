import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
const setup = new URL("./setup-supertest.ts", import.meta.url).href;

describe("shared server Codex test home", () => {
  it.each([true, false])("owns and cleans a synthetic home instead of inheriting credentials (preexisting=%s)", async preexisting => {
    const canary = await mkdtemp(join(tmpdir(), "paperclip-codex-setup-canary-"));
    const sentinel = join(canary, "auth.json");
    const bytes = "synthetic-canary-must-not-be-read-by-setup\n";
    await writeFile(sentinel, bytes, { mode: 0o600 });
    const original = await stat(sentinel);
    try {
      const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import path from "node:path";
        const canary = process.env.PAPERCLIP_TEST_CODEX_CANARY;
        const blocked = [];
        for (const name of ["accessSync", "lstatSync", "statSync", "readFileSync", "openSync", "readdirSync", "realpathSync", "writeFileSync", "rmSync", "unlinkSync", "renameSync"]) {
          const original = fs[name];
          fs[name] = function (...args) {
            if (args.some(value => typeof value === "string" && (value === canary || value.startsWith(canary + path.sep)))) {
              blocked.push(name);
              throw new Error("Shared test setup attempted canary credential I/O");
            }
            return Reflect.apply(original, fs, args);
          };
        }
        await import(${JSON.stringify(setup)});
        const home = process.env.CODEX_HOME;
        assert.ok(home && home !== canary);
        assert.equal(fs.lstatSync(home).isDirectory(), true);
        const auth = path.join(home, "auth.json");
        assert.deepEqual(JSON.parse(fs.readFileSync(auth, "utf8")), { OPENAI_API_KEY: "sk-vitest" });
        assert.equal(fs.statSync(auth).mode & 0o777, 0o600);
        assert.deepEqual(blocked, []);
        console.log(JSON.stringify({ home, blocked }));
      `], {
        env: { ...process.env, CODEX_HOME: preexisting ? canary : "", PAPERCLIP_TEST_CODEX_CANARY: canary },
        encoding: "utf8", timeout: 10_000,
      });
      expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: "" });
      const receipt = JSON.parse(result.stdout.trim()) as { home: string; blocked: string[] };
      expect(receipt.blocked).toEqual([]);
      expect(receipt.home).not.toBe(canary);
      await expect(stat(receipt.home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sentinel, "utf8")).toBe(bytes);
      const after = await stat(sentinel);
      expect({ mode: after.mode, mtimeMs: after.mtimeMs, ino: after.ino }).toEqual({ mode: original.mode, mtimeMs: original.mtimeMs, ino: original.ino });
    } finally { await rm(canary, { recursive: true, force: true }); }
  });
});
