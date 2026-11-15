import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { PaperclipSettings } from '../../core/schema.js';
import { paperclipPermissionOrigins } from '../../core/host-access.js';
import { createPaperclipLifecycle, paperclipLifecycleText, type PaperclipLifecycleSnapshot } from '../../core/paperclip/lifecycle.js';
import { workspaceApi } from './workspace/client.js';

const MANUAL_SERVICE_COMMANDS = {
  start: { command: "pnpm paperclipai service start" },
  logs: { command: "pnpm paperclipai service logs" },
} as const;

export interface PaperclipConnection {
  snapshot: PaperclipLifecycleSnapshot;
  retry: () => void;
  setup: () => void;
  allowAccess: () => void;
  /** A real app transport failure prompts a health check; it never starts an idle poll. */
  refresh?: () => void;
}

export const PaperclipConnectionContext = createContext<PaperclipConnection | null>(null);

/** `viewActive`: the Paperclip view itself is on screen, which tightens a running server's health check to 5 s. */
export function usePaperclipConnection(settings: PaperclipSettings | undefined, enabled: boolean, viewActive = false): PaperclipConnection {
  const origin = settings?.serverUrl || 'http://127.0.0.1:3100';
  const apiKey = settings?.auth === 'board_key' ? settings.apiKey : '';
  const controllerRef = useRef<ReturnType<typeof createPaperclipLifecycle> | null>(null);
  const viewActiveRef = useRef(viewActive);
  viewActiveRef.current = viewActive;
  const [snapshot, setSnapshot] = useState<PaperclipLifecycleSnapshot>({ state: 'starting', origin });
  useEffect(() => {
    const controller = createPaperclipLifecycle({
    origin,
    apiKey,
    activeView: viewActiveRef.current,
    hasAccess: async () => {
      const origins = paperclipPermissionOrigins(origin);
      if (!origins.length) return false;
      if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return true;
      return chrome.permissions.contains({ origins }).catch(() => false);
    },
    helper: {
      status: () => workspaceApi.paperclipServiceStatus(),
      start: (retry) => workspaceApi.paperclipServiceStart(retry),
      install: () => workspaceApi.paperclipServiceInstall(),
    },
    });
    controllerRef.current = controller;
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(setSnapshot);
    const visible = () => controller.setVisible(enabled && document.visibilityState !== 'hidden');
    visible();
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [origin, apiKey, enabled]);
  useEffect(() => { controllerRef.current?.setActiveView(viewActive); }, [viewActive]);
  return {
    snapshot,
    retry: () => void controllerRef.current?.retry(),
    setup: () => void controllerRef.current?.setup(),
    refresh: () => {
      const controller = controllerRef.current;
      if (!controller || !enabled || document.visibilityState === 'hidden') return;
      // If a health request was already in flight when the WebSocket disconnected,
      // its cached success can precede the failure. Follow that success with one fresh
      // probe instead of waiting for the normal healthy 30-second deadline.
      void controller.refresh().then(() => {
        if (controllerRef.current === controller && document.visibilityState !== 'hidden' && controller.getSnapshot().state === 'running') return controller.refresh();
      });
    },
    allowAccess: () => {
      const origins = paperclipPermissionOrigins(origin);
      if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
        void chrome.permissions.request({ origins }).then((allowed) => { if (allowed) return controllerRef.current?.refresh(); }).catch(() => undefined);
      } else void controllerRef.current?.refresh();
    },
  };
}

export function PaperclipStatus({ connection: provided, compact = false, summary = false, onConfigure }: {
  connection?: PaperclipConnection | null;
  compact?: boolean;
  summary?: boolean;
  onConfigure?: () => void;
}) {
  const shared = useContext(PaperclipConnectionContext);
  const connection = provided ?? shared;
  if (!connection) return null;
  const { snapshot, retry, setup, allowAccess } = connection;
  const text = paperclipLifecycleText(snapshot);
  return (
    <div className={compact ? 'tk-paperclip-status tk-paperclip-status-compact' : 'tk-paperclip-status'} data-state={snapshot.state}>
      <p role="status" title={text}>{compact ? <span aria-label={text}>PC · {snapshot.state === 'running' ? 'Running' : snapshot.state === 'starting' ? 'Starting…' : 'Offline'}</span> : text}</p>
      {!compact && !summary && <>
        {snapshot.state === 'not_installed' && snapshot.reason !== 'paperclip_not_registered' && <button type="button" className="tk-btn" onClick={setup}>Set up Paperclip</button>}
        {snapshot.state === 'stopped' && <>{snapshot.helperConnected !== false && <button type="button" className="tk-btn" onClick={retry}>Start</button>}<p className="tk-settings-note">{`Run "${MANUAL_SERVICE_COMMANDS.start.command}" in the Paperclip folder, or install the Mac helper to start it automatically.`}</p></>}
        {(snapshot.state === 'unreachable' || (snapshot.state === 'start_failed' && snapshot.reason !== 'paperclip_not_registered')) && <button type="button" className="tk-btn" onClick={retry}>Retry</button>}
        {snapshot.state === 'unreachable' && <button type="button" className="tk-btn" onClick={allowAccess}>Allow access</button>}
        {snapshot.state === 'needs_sign_in' && <button type="button" className="tk-btn" onClick={onConfigure}>Sign in</button>}
        {snapshot.state === 'setup_pending' && <button type="button" className="tk-btn" onClick={onConfigure}>Open Paperclip</button>}
        {snapshot.state === 'start_failed' && snapshot.reason !== 'paperclip_not_registered' && <p className="tk-settings-note">{`See "${MANUAL_SERVICE_COMMANDS.logs.command}" for details.`}</p>}
      </>}
      {(compact || summary) && snapshot.state !== 'running' && onConfigure && <button type="button" className="tk-linklike" onClick={onConfigure} aria-label="Paperclip connection settings">Connect</button>}
    </div>
  );
}
