/**
 * Optional change hint from a local Paperclip server.
 *
 * Paperclip pushes live events over a WebSocket at /api/companies/:id/events/ws. A local_trusted
 * instance accepts it without credentials; board API keys are refused there (403), so an
 * authenticated server is polled only. The socket is a hint: an issue or run event schedules a
 * normal sync a few seconds later, and the 5-minute alarm stays the source of truth (the service
 * worker, and with it the socket, can be stopped at any time).
 */
import { normalizeServerUrl } from './client.js';

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketLike {
  readyState: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

const RELEVANT_TYPES = new Set(['activity.logged', 'heartbeat.run.status', 'heartbeat.run.queued']);

/** Live event URL for one company (ws:// for http servers, wss:// for https). */
export function liveEventsUrl(serverUrl: string, companyId: string): string | null {
  const origin = normalizeServerUrl(serverUrl);
  if (!origin || !/^[A-Za-z0-9-]{1,64}$/.test(companyId)) return null;
  return `${origin.replace(/^http/, 'ws')}/api/companies/${companyId}/events/ws`;
}

/** True for events that mean an issue or one of its runs changed. */
export function isRelevantLiveEvent(data: unknown): boolean {
  let msg: unknown = data;
  if (typeof data === 'string') {
    try {
      msg = JSON.parse(data);
    } catch {
      return false;
    }
  }
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type?: unknown; payload?: { entityType?: unknown; status?: unknown } };
  if (typeof m.type !== 'string' || !RELEVANT_TYPES.has(m.type)) return false;
  if (m.type === 'activity.logged') return m.payload?.entityType === 'issue' || m.payload?.entityType === 'comment';
  return true;
}

export interface LiveHintOptions {
  serverUrl: string;
  companyIds: string[];
  /** Called (debounced) when something changed. */
  onChange: () => void;
  createSocket?: WebSocketFactory;
  debounceMs?: number;
}

export class PaperclipLiveHint {
  private sockets: WebSocketLike[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: LiveHintOptions;

  constructor(options: LiveHintOptions) {
    this.options = options;
  }

  /** Same server and companies as an already-open hint. */
  matches(serverUrl: string, companyIds: string[]): boolean {
    return (
      normalizeServerUrl(serverUrl) === normalizeServerUrl(this.options.serverUrl) &&
      [...companyIds].sort().join(',') === [...this.options.companyIds].sort().join(',')
    );
  }

  get isOpen(): boolean {
    return this.sockets.some((s) => s.readyState === 0 || s.readyState === 1);
  }

  open(): void {
    const create =
      this.options.createSocket ??
      ((url: string) => (typeof WebSocket === 'undefined' ? null : (new WebSocket(url) as unknown as WebSocketLike)));
    for (const companyId of this.options.companyIds.slice(0, 20)) {
      const url = liveEventsUrl(this.options.serverUrl, companyId);
      if (!url) continue;
      let socket: WebSocketLike | null = null;
      try {
        socket = create(url);
      } catch {
        socket = null;
      }
      if (!socket) continue;
      socket.onmessage = (event) => {
        if (isRelevantLiveEvent(event.data)) this.schedule();
      };
      socket.onerror = () => undefined;
      socket.onclose = () => {
        this.sockets = this.sockets.filter((s) => s !== socket);
      };
      this.sockets.push(socket);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.options.onChange();
    }, this.options.debounceMs ?? 8000);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
    this.sockets = [];
  }
}
