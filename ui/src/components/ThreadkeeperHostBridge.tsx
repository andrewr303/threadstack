import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createThreadkeeperBootChannel, createThreadkeeperHost, fusedPagesAvailable, readThreadkeeperExtensionIds } from "../lib/threadkeeper-host";
import { connectThreadkeeperFusion } from "../lib/threadkeeper-host-fusion";
import { subscribeCompanyLiveDisconnected } from "../lib/company-live-connection-events";
import { setVerifiedThreadkeeperHost } from "../lib/threadkeeper-host-state";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";

const framedByExtension = typeof window !== "undefined" && window.parent !== window && readThreadkeeperExtensionIds().length > 0;
const earlyHostMessages = (() => {
  if (!framedByExtension) return null;
  return createThreadkeeperBootChannel({ eventTarget: window, parent: window.parent, extensionIds: readThreadkeeperExtensionIds() });
})();
if (import.meta.hot) import.meta.hot.dispose(() => earlyHostMessages?.dispose());

/** Route synchronization leaves the real app, its authentication and its service worker intact. */
export function ThreadkeeperHostBridge() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = `${location.pathname}${location.search}${location.hash}`;
  const pathRef = useRef(path);
  const navigateRef = useRef(navigate);
  pathRef.current = path;
  navigateRef.current = navigate;
  const hostRef = useRef<ReturnType<typeof createThreadkeeperHost> | null>(null);
  const fusionRef = useRef<ReturnType<typeof connectThreadkeeperFusion> | null>(null);
  // REQ-6: fused mode is offered only while the browser-sessions plugin provides all three pages.
  const { data: contributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: framedByExtension,
    retry: false,
  });
  const fused = fusedPagesAvailable(contributions);
  const fusedRef = useRef(fused);
  fusedRef.current = fused;

  useEffect(() => {
    const extensionIds = readThreadkeeperExtensionIds();
    if (window.parent === window || extensionIds.length === 0) return;
    let fusion: ReturnType<typeof connectThreadkeeperFusion> | null = null;
    const host = createThreadkeeperHost({
      extensionIds,
      parent: window.parent,
      navigate: (next) => navigateRef.current(next),
      currentPath: () => pathRef.current,
      currentTitle: () => document.title,
      fusedAvailable: () => fusedRef.current,
      onOverlayQuery: () => fusion?.answerOverlayQuery(),
      onPalette: () => fusion?.openPalette(),
      onPlaced: (view) => fusion?.placed(view),
      onConnection: (connected) => {
        setVerifiedThreadkeeperHost(connected);
        document.documentElement.toggleAttribute("data-threadkeeper-host", connected);
        window.dispatchEvent(new CustomEvent("paperclip:threadkeeper-host", { detail: { connected, mode: fusedRef.current ? "fused" : "switching" } }));
        if (connected) fusion?.refresh();
      },
    });
    hostRef.current = host;
    fusion = connectThreadkeeperFusion({ doc: document, root: document.getElementById("root"), host });
    fusionRef.current = fusion;
    const message = (event: MessageEvent) => { host.handleMessage(event); };
    const detachMessages = earlyHostMessages?.attach(message);
    const openView = (event: Event) => {
      if (event instanceof CustomEvent) host.openView(event.detail?.view);
    };
    const click = (event: MouseEvent) => {
      if (fusion?.activateSlot(event)) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download")) return;
      let url: URL;
      try { url = new URL(anchor.href, window.location.href); } catch { return; }
      // Same-origin _blank links keep ordinary browser behavior.
      if (url.origin !== window.location.origin && host.openExternal(url.href)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const title = new MutationObserver(() => host.reportRoute());
    const stopLiveObserver = subscribeCompanyLiveDisconnected(() => { host.reportDisconnected(); });
    title.observe(document.head, { childList: true, subtree: true, characterData: true });
    if (!earlyHostMessages) window.addEventListener("message", message);
    window.addEventListener("paperclip:threadkeeper-open-view", openView);
    document.addEventListener("click", click, true);
    return () => {
      if (!earlyHostMessages) window.removeEventListener("message", message);
      detachMessages?.();
      window.removeEventListener("paperclip:threadkeeper-open-view", openView);
      document.removeEventListener("click", click, true);
      title.disconnect();
      stopLiveObserver();
      fusion?.dispose();
      fusion = null;
      fusionRef.current = null;
      host.disconnect();
      hostRef.current = null;
    };
  }, []);

  useEffect(() => { hostRef.current?.reportRoute(); }, [path]);
  useEffect(() => { fusionRef.current?.announceMode(); }, [fused]);
  return null;
}
