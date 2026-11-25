import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { codeMatches, expiresInLabel, groupedId, normalizeCodeInput } from './consent.js';

// The consent window for a Still (Sidebar Dock) pair request. It is a top-level popup opened by the
// service worker; decisions are accepted only from here (DOCK_DECIDE checks the sender URL).

interface PendingView {
  senderId: string;
  requestId: string;
  appName: string;
  appVersion: string;
  codeHash: string;
  at: string;
  expiresAt: string;
  expiresInMs: number;
  granted: boolean;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'ask'; pending: PendingView }
  | { kind: 'working'; pending: PendingView }
  | { kind: 'waiting'; pending: PendingView }
  | { kind: 'done'; title: string; body: string };

function send<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function applyTheme(): void {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function ConnectApp() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [matches, setMatches] = useState(false);
  const [remoteModels, setRemoteModels] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await send<{ ok: boolean; pending: PendingView | null }>({ type: 'DOCK_PENDING' });
      if (!res?.ok || !res.pending) {
        setPhase((p) => (p.kind === 'done' ? p : { kind: 'none' }));
        return;
      }
      const pending = res.pending;
      setPhase((p) => (p.kind === 'done' || p.kind === 'working' ? p : pending.granted ? { kind: 'waiting', pending } : { kind: 'ask', pending }));
    } catch {
      setPhase({ kind: 'none' });
    }
  }, []);

  useEffect(() => {
    applyTheme();
    void load();
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === 'DOCK_CHANGED') void load();
    };
    chrome.runtime.onMessage?.addListener(onMessage);
    return () => {
      clearInterval(tick);
      chrome.runtime.onMessage?.removeListener(onMessage);
    };
  }, [load]);

  const pending = phase.kind === 'ask' || phase.kind === 'working' || phase.kind === 'waiting' ? phase.pending : null;

  useEffect(() => {
    let live = true;
    if (!pending) return;
    void codeMatches(pending.requestId, code, pending.codeHash).then((ok) => {
      if (live) setMatches(ok);
    });
    return () => {
      live = false;
    };
  }, [code, pending]);

  useEffect(() => {
    if (phase.kind === 'ask') codeRef.current?.focus();
  }, [phase.kind]);

  const closeSoon = () => setTimeout(() => window.close(), 2500);

  const decide = async (allow: boolean) => {
    if (!pending) return;
    setError('');
    setPhase({ kind: 'working', pending });
    try {
      const res = await send<{ ok: boolean; status?: string; error?: string }>({
        type: 'DOCK_DECIDE',
        requestId: pending.requestId,
        allow,
        code,
        allowRemoteModels: remoteModels,
      });
      if (res?.ok && res.status === 'paired') {
        setPhase({ kind: 'done', title: 'Connected', body: `${pending.appName} can now receive the threads you choose in its settings. You can disconnect any time in ThreadStack → Settings → Sidebar Dock.` });
        closeSoon();
      } else if (res?.ok && res.status === 'granted') {
        setPhase({ kind: 'waiting', pending });
      } else if (res?.ok && res.status === 'denied') {
        setPhase({ kind: 'done', title: 'Denied', body: 'This extension cannot ask again until you unblock it in ThreadStack → Settings → Sidebar Dock.' });
        closeSoon();
      } else if (res?.status === 'wrong_code') {
        setError(res.error ?? 'That code does not match.');
        setPhase({ kind: 'ask', pending });
      } else {
        setPhase({ kind: 'done', title: 'Request ended', body: res?.error ?? 'This request is no longer waiting. Start again from Still.' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase({ kind: 'ask', pending });
    }
  };

  if (phase.kind === 'loading') {
    return <main className="cx" aria-busy="true"><p className="cx-muted">Loading…</p></main>;
  }
  if (phase.kind === 'none') {
    return (
      <main className="cx">
        <h1 className="cx-title">No request is waiting</h1>
        <p>Nothing is asking to connect to ThreadStack right now. Requests expire after 10 minutes; if you were connecting Still, press Connect in Still again.</p>
        <div className="cx-actions"><button type="button" className="cx-btn" onClick={() => window.close()}>Close</button></div>
      </main>
    );
  }
  if (phase.kind === 'done') {
    return (
      <main className="cx">
        <h1 className="cx-title">{phase.title}</h1>
        <p>{phase.body}</p>
        <div className="cx-actions"><button type="button" className="cx-btn" onClick={() => window.close()}>Close</button></div>
      </main>
    );
  }
  const p = phase.pending;
  const left = Math.max(0, Date.parse(p.expiresAt) - now);
  return (
    <main className="cx">
      <p className="cx-eyebrow">ThreadStack · Connection request</p>
      <h1 className="cx-title">An extension that calls itself “{p.appName}” wants to connect</h1>
      <dl className="cx-facts">
        <div><dt>Extension id</dt><dd className="cx-mono">{groupedId(p.senderId)}</dd></div>
        {p.appVersion ? <div><dt>Version</dt><dd>{p.appVersion}</dd></div> : null}
        <div><dt>Asked</dt><dd>{new Date(p.at).toLocaleTimeString()} · expires {expiresInLabel(left)}</dd></div>
      </dl>

      <section className="cx-section" aria-labelledby="cx-can">
        <h2 id="cx-can">If you allow it, it can</h2>
        <ul>
          <li>receive the threads you choose to sync in its own settings, with their summaries and (if you share them) full transcripts;</li>
          <li>search and read your threads, for example when its assistant answers a question;</li>
          <li>see the names of your ThreadStack projects and providers.</li>
        </ul>
        <p className="cx-muted">It never receives local-only threads, threads in local-only projects or threads from providers you excluded from cloud processing. Still may send what it receives to the AI provider you chose in Still.</p>
      </section>

      <div className="cx-warn" role="note">
        <strong>Only continue if you just clicked Connect in Still.</strong> If you did not, press Deny.
      </div>

      {phase.kind === 'waiting' ? (
        <p className="cx-status" role="status">Allowed. Waiting for Still to confirm… keep Still open; ThreadStack retries every 30 seconds.</p>
      ) : (
        <form
          className="cx-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches) void decide(true);
          }}
        >
          <label htmlFor="cx-code" className="cx-label">Code Still is showing</label>
          <input
            id="cx-code"
            ref={codeRef}
            className="cx-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            aria-describedby="cx-code-help"
            aria-invalid={code.length === 6 && !matches ? true : undefined}
            onChange={(e) => setCode(normalizeCodeInput(e.target.value))}
          />
          <p id="cx-code-help" className="cx-muted">
            {code.length === 6 && !matches ? 'That is not the code Still shows.' : 'Type the 6 digits from Still’s settings to enable Allow.'}
          </p>
          <label className="cx-check">
            <input type="checkbox" checked={remoteModels} onChange={(e) => setRemoteModels(e.target.checked)} />
            <span>Also let Still’s searches use my embedding and rerank providers (its search text goes to them). You can change this later.</span>
          </label>
          {error ? <p className="cx-error" role="alert">{error}</p> : null}
          <div className="cx-actions">
            <button type="button" className="cx-btn" onClick={() => void decide(false)} disabled={phase.kind === 'working'}>Deny</button>
            <button type="submit" className="cx-btn cx-btn-primary" disabled={!matches || phase.kind === 'working'}>
              {phase.kind === 'working' ? 'Allowing…' : 'Allow'}
            </button>
          </div>
        </form>
      )}
    </main>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<ConnectApp />);
