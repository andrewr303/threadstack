import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedLiveTransport } from "./hosted-live-transport";

class Socket {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  send = vi.fn();
}
class Stream {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
}
function setup(hosted: boolean) {
  const socket = new Socket(); const stream = new Stream();
  const callbacks = { onOpen: vi.fn(), onMessage: vi.fn(), onLost: vi.fn(), onClosed: vi.fn(), onFallback: vi.fn() };
  const verified = { value: hosted }; let ready: (() => void) | null = null; const unsubscribe = vi.fn();
  const createSource = vi.fn(() => stream as unknown as EventSource);
  const transport = createHostedLiveTransport({
    socketUrl: "ws://localhost/api/companies/company-a/events/ws", streamUrl: "/api/companies/company-a/events/stream",
    createSocket: () => socket as unknown as WebSocket, createSource,
    disposeSocket: target => target.close(), isVerifiedHost: () => verified.value,
    subscribeVerifiedHost: listener => { ready = listener; return unsubscribe; }, ...callbacks,
  });
  return { socket, stream, createSource, callbacks, transport, unsubscribe, verify: () => { verified.value = true; ready?.(); }, unverify: () => { verified.value = false; ready?.(); } };
}
afterEach(() => vi.unstubAllGlobals());

describe("native company events transport in a verified extension host", () => {
  it("keeps ordinary browser WebSockets and emits one outage notification", () => {
    const t = setup(false);
    t.socket.onopen?.({} as Event);
    expect(t.callbacks.onOpen).toHaveBeenCalledWith(t.socket);
    t.socket.onerror?.({} as Event); t.socket.onclose?.({} as CloseEvent);
    expect(t.createSource).not.toHaveBeenCalled();
    expect(t.callbacks.onLost).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onClosed).toHaveBeenCalledTimes(1);
    t.transport.dispose(); expect(t.unsubscribe).toHaveBeenCalledOnce();
  });

  it("replaces a blocked hosted WebSocket with exactly one authenticated HTTP stream", () => {
    const t = setup(true);
    t.socket.onerror?.({} as Event);
    expect(t.socket.close).toHaveBeenCalledTimes(1); expect(t.createSource).toHaveBeenCalledOnce();
    expect(t.callbacks.onLost).not.toHaveBeenCalled();
    t.stream.readyState = 1; t.stream.onopen?.({} as Event);
    expect(t.callbacks.onOpen).toHaveBeenCalledWith(null);
    t.stream.onmessage?.({ data: '{"type":"activity.logged"}' } as MessageEvent);
    expect(t.callbacks.onMessage).toHaveBeenCalledWith('{"type":"activity.logged"}');
    expect(t.transport.mode()).toBe("eventsource");
    t.transport.dispose(); expect(t.stream.close).toHaveBeenCalledOnce();
  });

  it("switches after a late verified-host handshake without retaining an old reconnect channel", () => {
    const t = setup(false);
    t.socket.onerror?.({} as Event); t.socket.onclose?.({} as CloseEvent);
    expect(t.createSource).not.toHaveBeenCalled();
    t.verify();
    expect(t.createSource).toHaveBeenCalledOnce(); expect(t.callbacks.onFallback).toHaveBeenCalledOnce();
    t.verify(); expect(t.createSource).toHaveBeenCalledOnce();
    t.transport.dispose();
  });

  it("emits once per SSE outage, resets after recovery and ignores stale callbacks after cleanup", () => {
    const t = setup(true); t.socket.onerror?.({} as Event);
    t.stream.onopen?.({} as Event);
    t.stream.onerror?.({} as Event); t.stream.onerror?.({} as Event);
    expect(t.callbacks.onLost).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onClosed).not.toHaveBeenCalled();
    t.stream.onopen?.({} as Event); t.stream.onerror?.({} as Event);
    expect(t.callbacks.onLost).toHaveBeenCalledTimes(2);
    const late = t.stream.onmessage;
    t.transport.dispose(); late?.({ data: "old company event" } as MessageEvent);
    expect(t.callbacks.onMessage).not.toHaveBeenCalled();
  });

  it("uses the native credentialed same-origin EventSource contract without tokens", () => {
    const constructor = vi.fn(function(this: Stream) { Object.assign(this, new Stream()); });
    vi.stubGlobal("EventSource", constructor);
    const socket = new Socket();
    const transport = createHostedLiveTransport({ socketUrl: "ws://localhost/api/companies/a/events/ws", streamUrl: "/api/companies/a/events/stream", createSocket: () => socket as unknown as WebSocket, disposeSocket: target => target.close(), isVerifiedHost: () => true, subscribeVerifiedHost: () => () => {}, onOpen: vi.fn(), onMessage: vi.fn(), onLost: vi.fn(), onClosed: vi.fn(), onFallback: vi.fn() });
    socket.onerror?.({} as Event);
    expect(constructor).toHaveBeenCalledWith("/api/companies/a/events/stream", { withCredentials: true });
    transport.dispose();
  });

  it("releases the HTTP stream when the verified host handshake is withdrawn", () => {
    const t = setup(true); t.socket.onerror?.({} as Event); t.stream.onopen?.({} as Event);
    t.unverify();
    expect(t.stream.close).toHaveBeenCalledOnce();
    expect(t.callbacks.onLost).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onClosed).toHaveBeenCalledTimes(1);
    t.transport.dispose(); expect(t.stream.close).toHaveBeenCalledOnce();
  });
});
