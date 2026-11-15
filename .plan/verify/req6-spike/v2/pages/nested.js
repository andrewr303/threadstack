// Throwaway provider-page stand-in: records the keys it receives.
window.__keys = [];
window.addEventListener('keydown', (event) => { window.__keys.push({ key: event.key, meta: event.metaKey, ctrl: event.ctrlKey }); });
