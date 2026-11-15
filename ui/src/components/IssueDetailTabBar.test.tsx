// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tabs, TabsContent } from "./ui/tabs";
import { IssueDetailTabBar, resolveTaskDetailTab } from "./IssueDetailTabBar";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); });
const pluginTabs = [{ value: "plugin:browser-sessions:task", label: "Sessions" }];
function Task({ plugins = pluginTabs }: { plugins?: typeof pluginTabs }) {
  const [selected, setSelected] = useState("chat");
  return <Tabs value={resolveTaskDetailTab(selected, true, plugins)} onValueChange={setSelected}>
    <IssueDetailTabBar taskChatShellEnabled pluginTabs={plugins} />
    <TabsContent value="chat">Task conversation</TabsContent>
    <TabsContent value={pluginTabs[0].value}>Linked browser sessions</TabsContent>
  </Tabs>;
}
describe("plugin tabs in the current task chat shell", () => {
  it("exposes and selects Sessions while keeping retired native tabs hidden", async () => {
    await act(() => root.render(<Task />));
    const sessions = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === "Sessions")!;
    expect(sessions).toBeDefined(); expect(container.textContent).not.toContain("Related work"); expect(container.textContent).not.toContain("Activity");
    await act(() => sessions.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(sessions.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Linked browser sessions");
    expect(container.textContent).not.toContain("Task conversation");
  });
  it("keeps the normal tab-free chat surface when no plugin contributes tabs", async () => {
    await act(() => root.render(<Task plugins={[]} />));
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.textContent).toBe("Task conversation");
    expect(resolveTaskDetailTab("plugin:removed:task", true, [])).toBe("chat");
  });
});
