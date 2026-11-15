import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThreadkeeperHostConfig, readBrandedStaticIndexHtml } from "../static-index-html.js";

describe("static SPA fallback HTML", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes only explicit validated extension IDs without script injection", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    vi.stubEnv("PAPERCLIP_THREADKEEPER_EXTENSION_IDS", `${id},${id},</script><script>alert(1)</script>,bad`);
    const html = applyThreadkeeperHostConfig("<html><head></head><body>App</body></html>");
    expect(html).toContain(`<meta name="paperclip-threadkeeper-extension-ids" content="${id}">`);
    expect(html).not.toContain("<script>");
    expect(applyThreadkeeperHostConfig(html).match(/paperclip-threadkeeper-extension-ids/g)).toHaveLength(1);
  });

  it("has an empty allowlist by default, including after the setting is removed", () => {
    vi.stubEnv("PAPERCLIP_THREADKEEPER_EXTENSION_IDS", undefined);
    const html = applyThreadkeeperHostConfig('<head><meta name="paperclip-threadkeeper-extension-ids" content="abcdefghijklmnopabcdefghijklmnop"></head>');
    expect(html).toContain('content=""');
    expect(html).not.toContain("abcdefghijklmnop");
  });

  it("ignores retired snippet settings in managed and self-hosted static HTML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cloud-html-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body>App</body></html>");
    vi.stubEnv("PAPERCLIP_CLOUD_UI_SNIPPET", '<script src="https://example.com/chat.js"></script>');
    vi.stubEnv("PAPERCLIP_CLOUD_UI_SNIPPET_B64", Buffer.from('<script src="https://example.com/legacy.js"></script>').toString("base64"));
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("chat.js");
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", "{}");
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("chat.js");
    vi.stubEnv("PAPERCLIP_CLOUD_UI_SNIPPET", undefined);
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("legacy.js");
  });

  it("serves the current index.html instead of reusing stale asset hashes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-static-index-"));
    tempDirs.push(tempDir);
    const indexPath = path.join(tempDir, "index.html");
    const app = express();
    app.get(/.*/, (_req, res) => {
      res
        .status(200)
        .set("Content-Type", "text/html")
        .set("Cache-Control", "no-cache")
        .end(readBrandedStaticIndexHtml(tempDir));
    });

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-old.js"></script></body></html>',
      "utf8",
    );
    await expect(request(app).get("/PAP/issues/PAP-9939")).resolves.toMatchObject({
      text: expect.stringContaining("/assets/index-old.js"),
    });

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-new.js"></script></body></html>',
      "utf8",
    );
    const res = await request(app).get("/PAP/issues/PAP-9939");
    expect(res.text).toContain("/assets/index-new.js");
    expect(res.text).not.toContain("/assets/index-old.js");
  });
});
