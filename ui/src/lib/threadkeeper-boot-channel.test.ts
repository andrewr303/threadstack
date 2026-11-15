// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createThreadkeeperBootChannel } from "./threadkeeper-host";
const id = "abcdefghijklmnopabcdefghijklmnop";
function setup() {
  const target = new EventTarget();
  const channel = createThreadkeeperBootChannel({ eventTarget: target, parent: window, extensionIds: [id] });
  const message = (data: Record<string, unknown>, origin = `chrome-extension://${id}`, source: Window | null = window) => target.dispatchEvent(new MessageEvent("message", { origin, source, data: { source: "threadkeeper-shell", v: 1, ...data } }));
  const send = (type: string, path?: string, origin = `chrome-extension://${id}`, source: Window | null = window) => message({ type, path }, origin, source);
  return { channel, send, message };
}
const liveMessages = [{ type: "placed", view: "threads" }, { type: "command", name: "palette" }];
describe("origin-checked host messages during application boot", () => {
  it("retains an early valid hello until the router bridge mounts", () => {
    const { channel, send } = setup(); const received: string[] = [];
    send("hello", undefined, "https://evil.test"); send("hello", undefined, `chrome-extension://${id}`, null);
    send("hello"); channel.attach(event => received.push(event.data.type));
    expect(received).toEqual(["hello"]); channel.dispose();
  });
  it("replays the authenticated hello across a React effect remount without stale navigation", () => {
    const { channel, send } = setup(); const first: string[] = []; const second: string[] = [];
    const detach = channel.attach(event => first.push(event.data.type)); send("hello"); send("navigate", "/THR/issues"); detach();
    channel.attach(event => second.push(event.data.type));
    expect(first).toEqual(["hello", "navigate"]); expect(second).toEqual(["hello"]); channel.dispose();
  });
  it("buffers only the latest valid navigation after a verified early hello", () => {
    const { channel, send } = setup(); const received: Array<{ type: string; path?: string }> = [];
    send("navigate", "/before-hello"); send("hello"); send("navigate", "/one"); send("navigate", "//evil.test"); send("navigate", "/latest");
    channel.attach(event => received.push(event.data));
    expect(received.map(event => [event.type, event.path])).toEqual([["hello", undefined], ["navigate", "/latest"]]); channel.dispose();
  });
  it("drops later messages after disposing its owned listener", () => {
    const { channel, send } = setup(); const received: string[] = [];
    channel.attach(event => received.push(event.data.type)); channel.dispose(); send("hello");
    expect(received).toEqual([]);
  });

  it.each(liveMessages)("forwards $type directly to the attached consumer after hello (N-4)", (data) => {
    const { channel, send, message } = setup();
    const receive = vi.fn();
    try {
      channel.attach(receive);
      send("hello");
      receive.mockClear();
      message(data);
      expect(receive).toHaveBeenCalledTimes(1);
      expect(receive.mock.lastCall![0].data).toEqual({ source: "threadkeeper-shell", v: 1, ...data });
    } finally { channel.dispose(); }
  });

  it.each(["before hello", "wrong origin", "wrong source"])("refuses placed and command at the boot channel itself: %s (N-4)", (refusal) => {
    const { channel, send, message } = setup();
    const receive = vi.fn();
    try {
      channel.attach(receive);
      if (refusal !== "before hello") send("hello");
      receive.mockClear();
      for (const data of liveMessages) {
        message(data, refusal === "wrong origin" ? "https://evil.test" : `chrome-extension://${id}`, refusal === "wrong source" ? null : window);
      }
      // No host is attached here: this assertion isolates the boot-channel guards.
      expect(receive).not.toHaveBeenCalled();
    } finally { channel.dispose(); }
  });

  it("does not buffer placed or command across attachment or an effect remount", () => {
    const { channel, send, message } = setup();
    const first = vi.fn();
    const remounted = vi.fn();
    try {
      send("hello");
      liveMessages.forEach((data) => message(data));
      const detach = channel.attach(first);
      expect(first.mock.calls.map(([event]) => event.data.type)).toEqual(["hello"]);
      liveMessages.forEach((data) => message(data));
      expect(first.mock.calls.map(([event]) => event.data.type)).toEqual(["hello", "placed", "command"]);
      detach();
      liveMessages.forEach((data) => message(data));
      channel.attach(remounted);
      expect(remounted.mock.calls.map(([event]) => event.data.type)).toEqual(["hello"]);
    } finally { channel.dispose(); }
  });
});
