/** Optional same-document observers can react to native live-connection loss. */
const DISCONNECTED = "paperclip:company-live-disconnected";

export function notifyCompanyLiveDisconnected(companyId: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DISCONNECTED, { detail: { companyId } }));
}

export function subscribeCompanyLiveDisconnected(listener: (companyId: string) => void): () => void {
  const receive = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail?.companyId === "string" && event.detail.companyId) listener(event.detail.companyId);
  };
  window.addEventListener(DISCONNECTED, receive);
  return () => window.removeEventListener(DISCONNECTED, receive);
}
