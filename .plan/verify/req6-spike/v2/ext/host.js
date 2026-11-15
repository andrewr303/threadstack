// Throwaway host logic for the REQ-6 spike. Not product code.
// Query: ?frame=<origin>&nested=<origin>&clip=1|0&focus=host|frame&iframeScheme=<css color-scheme>|none
//        &hostScheme=<css color-scheme>|none&restoreDelay=<ms>
const params = new URLSearchParams(location.search);
const frameOrigin = params.get('frame');
const nestedOrigin = params.get('nested');
const focusMode = params.get('focus') || 'host';
const restoreDelay = Number(params.get('restoreDelay') || 0);
// layer=1 selects the layered variant: the view sits ABOVE the frame by z-order, the frame is raised
// while a blocking overlay is open, and non-blocking notices show through holes cut in the VIEW.
const layerMode = params.get('layer') === '1';
const frame = document.getElementById('paperclip');
const view = document.getElementById('view');
const log = [];
window.__log = log;
window.__state = { slot: null, overlayOpen: false, regions: [], clipped: false, clipEnabled: params.get('clip') !== '0', ready: false };
const record = (kind, detail = {}) => { log.push({ t: performance.now(), kind, ...detail }); };

if (params.get('hostScheme') && params.get('hostScheme') !== 'none') document.documentElement.style.colorScheme = params.get('hostScheme');
if (params.get('iframeScheme') && params.get('iframeScheme') !== 'none') frame.style.colorScheme = params.get('iframeScheme');

let lastViewFocus = null;
view.addEventListener('focusin', (event) => { lastViewFocus = event.target; });
view.addEventListener('click', (event) => record('view-click', { x: event.clientX, y: event.clientY, target: event.target.id || event.target.tagName }));
document.getElementById('underlay').addEventListener('click', () => record('underlay-click'));
document.getElementById('underlay').addEventListener('mouseenter', () => record('underlay-hover'));

function applyLayers() {
  const state = window.__state;
  const raised = state.overlayOpen;
  frame.style.clipPath = 'none';
  frame.style.zIndex = raised ? '30' : '10';
  view.style.zIndex = '20';
  const slot = state.slot;
  if (!raised && slot && state.regions.length) {
    // Holes in the view, in the view's own coordinates. The connecting segments have zero area.
    const parts = ['0px 0px', '100% 0px', '100% 100%', '0px 100%', '0px 0px'];
    for (const region of state.regions) {
      const x = region.x - slot.x; const y = region.y - slot.y; const r = x + region.width; const b = y + region.height;
      parts.push(`${x}px ${y}px`, `${r}px ${y}px`, `${r}px ${b}px`, `${x}px ${b}px`, `${x}px ${y}px`, '0px 0px');
    }
    view.style.clipPath = `polygon(evenodd, ${parts.join(', ')})`;
  } else {
    view.style.clipPath = 'none';
  }
  state.clipped = Boolean(slot && !raised); // "steady state" flag shared with the clip variant
}

function applyClip() {
  if (layerMode) { applyLayers(); return; }
  const state = window.__state;
  const slot = state.slot;
  const shouldClip = Boolean(state.clipEnabled && slot && !state.overlayOpen);
  if (shouldClip) {
    const { x, y, width, height } = slot;
    const r = x + width; const b = y + height;
    // Outer rectangle, then the hole; evenodd removes the hole from both painting and hit testing.
    frame.style.clipPath = `polygon(evenodd, 0px 0px, 100% 0px, 100% 100%, 0px 100%, 0px 0px, ${x}px ${y}px, ${r}px ${y}px, ${r}px ${b}px, ${x}px ${b}px, ${x}px ${y}px)`;
  } else {
    frame.style.clipPath = 'none';
  }
  state.clipped = shouldClip;
}

function placeView() {
  const slot = window.__state.slot;
  if (!slot) return;
  view.style.left = `${slot.x}px`; view.style.top = `${slot.y}px`;
  view.style.width = `${slot.width}px`; view.style.height = `${slot.height}px`;
}

window.addEventListener('message', (event) => {
  if (event.origin !== frameOrigin || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.source !== 'paperclip-ui' || data.v !== 1) return;
  const latency = typeof data.sentAt === 'number' ? (performance.timeOrigin + performance.now()) - data.sentAt : null;
  if (data.type === 'ready') { window.__state.ready = true; record('ready'); }
  else if (data.type === 'slot') {
    const rect = data.rect;
    const valid = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0
      && rect.x + rect.width <= window.innerWidth + 1 && rect.y + rect.height <= window.innerHeight + 1;
    if (!valid) { record('slot-ignored', { rect }); return; }
    window.__state.slot = rect; placeView(); applyClip(); record('slot', { rect, latency });
  } else if (data.type === 'overlay') {
    const open = data.open === true;
    const regions = Array.isArray(data.regions) ? data.regions.filter((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0) : [];
    const apply = () => {
      const wasOpen = window.__state.overlayOpen;
      window.__state.overlayOpen = open;
      window.__state.regions = regions;
      applyClip();
      if (wasOpen && !open && lastViewFocus && document.activeElement === frame) lastViewFocus.focus();
      record('overlay', { open, latency, active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null });
    };
    if (!open && restoreDelay > 0) setTimeout(apply, restoreDelay); else apply();
  } else if (data.type === 'record') {
    record('frame', { message: data.message });
  }
});

function openPalette() {
  if (focusMode === 'host') frame.focus();
  frame.contentWindow.postMessage({ source: 'threadkeeper-shell', v: 1, type: 'command', name: 'palette' }, frameOrigin);
}
// Command+K (or Control+K) with focus in the view: the shell asks Paperclip for its palette.
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    record('host-shortcut');
    openPalette();
  }
});
window.__openPalette = openPalette;
window.__setClipEnabled = (enabled) => { window.__state.clipEnabled = enabled; applyClip(); };
window.__forceOverlay = (open) => { window.__state.overlayOpen = open; applyClip(); };
window.__active = () => (document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null);

frame.addEventListener('load', () => {
  frame.contentWindow.postMessage({ source: 'threadkeeper-shell', v: 1, type: 'hello' }, frameOrigin);
});
frame.src = `${frameOrigin}/frame.html?host=${encodeURIComponent(location.origin)}&${params.toString()}`;
if (nestedOrigin) document.getElementById('nested').src = `${nestedOrigin}/nested.html`;
