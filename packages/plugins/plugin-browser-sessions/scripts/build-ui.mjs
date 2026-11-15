import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let commit = "unknown";
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim(); } catch {}
mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
writeFileSync(path.join(packageRoot, "dist/build-info.json"), JSON.stringify({ commit, builtAt: new Date().toISOString() }));
await esbuild.build({ entryPoints: [path.join(packageRoot, "src/ui/index.tsx")], outfile: path.join(packageRoot, "dist/ui/index.js"), bundle: true, format: "esm", platform: "browser", target: ["es2022"], sourcemap: true, external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"], logLevel: "info" });
