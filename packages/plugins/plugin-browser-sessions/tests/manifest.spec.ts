import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

// REQ-6 AC-1: Browse, Threads and Session board come from this plugin's sidebar entry and pages.
describe("ThreadStack pages in Paperclip's sidebar (REQ-6 AC-1)", () => {
  const slots = manifest.ui?.slots ?? [];

  it("declares the three pages with their routes and labels", () => {
    const pages = slots.filter((slot) => slot.type === "page").map((slot) => [slot.routePath, slot.displayName]);
    expect(pages).toEqual([["browse", "Browse"], ["threads", "Threads"], ["session-board", "Session board"]]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["ui.sidebar.register", "ui.page.register"]));
  });

  it("registers the sidebar entry that links to them", () => {
    expect(slots.filter((slot) => slot.type === "sidebar").map((slot) => slot.exportName)).toEqual(["SessionSidebar"]);
  });
});
