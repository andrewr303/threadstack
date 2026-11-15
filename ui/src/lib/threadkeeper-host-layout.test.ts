import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../components/Layout.tsx", import.meta.url), "utf8");
const mobileHost = '.paperclip-app-shell[data-mobile="true"]:has(.threadkeeper-slot)';

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

// Structural contract only: jsdom cannot prove a slot's rendered size. Browser acceptance
// must check desktop-to-mobile resize with the real Layout and the reported slot rectangle.
describe("Threadkeeper mobile host layout", () => {
  it("gives the absolute slot a bounded flex chain before placement is acknowledged", () => {
    // Layout's mobile document normally has natural height. Its named ancestors must remain
    // the ones scoped here, rather than reusing desktop-only flex utility classes.
    for (const name of ["paperclip-app-shell", "app-main-row", "app-content-column", "app-content-row"]) {
      expect(layout).toContain(name);
    }
    const shell = cssBlock(mobileHost);
    expect(shell).toContain("display: flex;");
    expect(shell).toContain("flex-direction: column;");
    expect(shell).toContain("height: 100dvh;");
    expect(shell).toContain("min-height: 0;");
    const rows = cssBlock(`${mobileHost} :is(.app-main-row, .app-content-row)`);
    expect(rows).toContain("display: flex;");
    expect(rows).toContain("flex: 1;");
    expect(rows).toContain("min-height: 0;");
    const column = cssBlock(`${mobileHost} .app-content-column`);
    expect(column).toContain("flex: 1;");
    expect(column).toContain("min-height: 0;");
    expect(cssBlock(`${mobileHost} .app-breadcrumb`)).toContain("flex-shrink: 0;");
    expect(cssBlock("#main-content:has(.threadkeeper-slot)")).toContain("min-height: 0;");
  });

  it("keeps the slot measured from its actual content area, without a fabricated size", () => {
    const slot = cssBlock(".threadkeeper-slot");
    expect(slot).toContain("position: absolute;");
    expect(slot).toContain("inset: 0;");
    expect(slot).not.toMatch(/(?:min-)?(?:width|height):/);
  });
});
