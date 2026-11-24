import React, { useEffect, useRef, useState } from 'react';
import { paperclipPath, parsePaperclipHostMessage, type PaperclipHostMessage } from '../../core/paperclip/host.js';
import { EMBED_ALLOW, EMBED_SANDBOX } from './workspace/useWorkspace.js';
import { PaperclipConnectCard, type PaperclipConnection } from './PaperclipConnection.js';
import { Icon } from './shell/icons.js';

export interface PaperclipNavigation { path: string; request: number }

/** What the shell may do with the Paperclip frame (REQ-6 fused mode): message it and focus it. */
export interface PaperclipFrameControl {
  post: (body: Record<string, unknown>) => boolean;
  focus: () => void;
  frame: () => HTMLIFrameElement | null;
}

/** A sibling of provider frames, kept outside the session budget and capture channel. */
export function PaperclipView({ origin, initialPath = '/', active, eager = false, connection, navigation, onMessage, onConfigure, onOpenInTab, header = false, controlRef }: {
  origin: string;
  /** Show the glass header (status, address, actions) above the app. Off in fused mode, where Paperclip lays out the window. */
  header?: boolean;
  /** Open the Paperclip app in an ordinary browser tab. */
  onOpenInTab?: () => void;
  initialPath?: string;
  active: boolean;
  /** Load the frame while the server runs even before Paperclip is shown (it lays out the window). */
  eager?: boolean;
  connection: PaperclipConnection;
  navigation?: PaperclipNavigation;
  onMessage: (message: PaperclipHostMessage) => void;
  onConfigure: () => void;
  controlRef?: React.MutableRefObject<PaperclipFrameControl | null>;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const firstPath = useRef(paperclipPath(initialPath) ?? '/').current;
  const lastPath = useRef(firstPath);
  const handshakeReady = useRef(false);
  const pendingPath = useRef<string | null>(null);
  const navigationRequest = useRef(-1);
  const [visited, setVisited] = useState(false);
  const [ready, setReady] = useState(false);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const offline = useRef(false);
  const running = connection.snapshot.state === 'running';
  const onMessageRef = useRef(onMessage);
  const connectionRef = useRef(connection);
  onMessageRef.current = onMessage;
  connectionRef.current = connection;
  useEffect(() => { if ((active || eager) && running) setVisited(true); }, [active, eager, running]);
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      post: (body) => {
        const target = frame.current?.contentWindow;
        if (!target) return false;
        target.postMessage({ source: 'threadkeeper-shell', v: 1, ...body }, origin);
        return true;
      },
      focus: () => frame.current?.focus(),
      frame: () => frame.current,
    };
    return () => { controlRef.current = null; };
  }, [controlRef, origin]);
  useEffect(() => {
    if (!visited) return;
    if (!running) { offline.current = true; return; }
    if (offline.current && frame.current) {
      handshakeReady.current = false;
      setReady(false);
      frame.current.src = `${origin}${lastPath.current}`;
    }
    offline.current = false;
  }, [visited, running, origin]);
  useEffect(() => {
    if (!visited || ready || !running) return;
    const timer = setTimeout(() => setReady(true), 10_000);
    return () => clearTimeout(timer);
  }, [visited, ready, running, documentGeneration]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const element = frame.current;
      // Slot rectangles are in the frame's own viewport; validate against it, then move them into ours.
      const bounds = element && element.clientWidth > 0 && element.clientHeight > 0
        ? { width: element.clientWidth, height: element.clientHeight }
        : { width: window.innerWidth, height: window.innerHeight };
      let message = parsePaperclipHostMessage(event, element?.contentWindow, origin, bounds);
      if (!message) return;
      if (message.type === 'slot' && element) {
        // A mismatched color-scheme makes the transparent frame paint an opaque canvas (spike check 1).
        element.style.colorScheme = message.scheme;
        if (message.rect) {
          const box = element.getBoundingClientRect();
          message = { ...message, rect: { ...message.rect, x: message.rect.x + box.left + element.clientLeft, y: message.rect.y + box.top + element.clientTop } };
        }
      }
      if (message.type === 'disconnected') connectionRef.current.refresh?.();
      if (message.type === 'ready') {
        handshakeReady.current = true;
        setReady(true);
        if (pendingPath.current) {
          frame.current?.contentWindow?.postMessage({ source: 'threadkeeper-shell', v: 1, type: 'navigate', path: pendingPath.current }, origin);
          pendingPath.current = null;
        }
      }
      if (message.type === 'route') lastPath.current = message.path;
      onMessageRef.current(message);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [origin]);
  useEffect(() => {
    const path = paperclipPath(navigation?.path);
    if (!path || !visited || navigationRequest.current === navigation?.request) return;
    navigationRequest.current = navigation?.request ?? 0;
    lastPath.current = path;
    pendingPath.current = path;
    if (handshakeReady.current) {
      frame.current?.contentWindow?.postMessage({ source: 'threadkeeper-shell', v: 1, type: 'navigate', path }, origin);
      pendingPath.current = null;
    }
  }, [navigation?.request, visited, origin]);
  useEffect(() => {
    if (!visited || !running) return;
    // A cold server can finish booting after the frame load event. Retry hello without
    // touching its document or creating extra history entries.
    const timer = setInterval(() => {
      if (handshakeReady.current) { clearInterval(timer); return; }
      frame.current?.contentWindow?.postMessage({ source: 'threadkeeper-shell', v: 1, type: 'hello' }, origin);
    }, 1_000);
    const stop = setTimeout(() => clearInterval(timer), 60_000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [visited, running, origin, documentGeneration]);
  return (
    <section className="tk-view tk-view-paperclip" aria-label="Paperclip" hidden={!active} data-header={header && running ? 'true' : undefined}>
      {header && running && (
        <div className="tk-paperclip-bar tk-glass" role="group" aria-label="Paperclip connection">
          <span className="tk-paperclip-live" aria-hidden="true" />
          <strong className="tk-paperclip-bar-title">Paperclip</strong>
          <span className="tk-paperclip-bar-origin" title={origin}>{displayOrigin(origin)}</span>
          <span className="tk-visually-hidden" role="status">Paperclip is running</span>
          <span className="tk-paperclip-bar-spacer" />
          {onOpenInTab && (
            <button type="button" className="tk-btn tk-btn-quiet" onClick={onOpenInTab}>
              <Icon name="external" />
              <span className="tk-paperclip-bar-label">Open in Chrome tab</span>
            </button>
          )}
          <button type="button" className="tk-btn" onClick={onConfigure}>
            <Icon name="settings" />
            <span className="tk-paperclip-bar-label">Connection</span>
          </button>
        </div>
      )}
      {visited && <iframe
        ref={frame}
        className="tk-paperclip-frame"
        title="Paperclip"
        src={`${origin}${firstPath}`}
        sandbox={EMBED_SANDBOX}
        allow={EMBED_ALLOW}
        style={!active || !running ? { display: 'none' } : undefined}
        onLoad={() => {
          handshakeReady.current = false;
          setReady(false);
          // A later full-document navigation needs a fresh retry window even though this
          // iframe stays mounted and the previous document already acknowledged hello.
          setDocumentGeneration(generation => generation + 1);
          frame.current?.contentWindow?.postMessage({ source: 'threadkeeper-shell', v: 1, type: 'hello' }, origin);
        }}
      />}
      {active && !running && <div className="tk-paperclip-empty"><PaperclipConnectCard connection={connection} onConfigure={onConfigure} /></div>}
      {active && running && !ready && <div className="tk-paperclip-loading" role="status">Opening Paperclip…</div>}
    </section>
  );
}

/** `localhost:3100` for http://localhost:3100: the host and port, without the scheme. */
function displayOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
