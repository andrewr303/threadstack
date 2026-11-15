// Throwaway Paperclip stand-in for the REQ-6 spike. Not product code.
const params = new URLSearchParams(location.search);
const hostOrigin = params.get('host');
const focusMode = params.get('focus') || 'host';
if (params.get('opaque') === '1') document.body.classList.add('opaque');
if (params.get('docScheme') && params.get('docScheme') !== 'none') document.documentElement.style.colorScheme = params.get('docScheme');

const flog = [];
window.__flog = flog;
const record = (kind, detail = {}) => { flog.push({ t: performance.timeOrigin + performance.now(), kind, ...detail }); };

let parentOrigin = null;
const post = (body) => { if (parentOrigin) parent.postMessage({ source: 'paperclip-ui', v: 1, sentAt: performance.timeOrigin + performance.now(), ...body }, parentOrigin); };

// One counter for every blocking overlay kind; `open` is true while it is above zero (REQ-6 FR-3).
// With ?notices=regions a non-blocking notice is reported as a rectangle instead of counting as open.
const noticesAsRegions = params.get('notices') === 'regions';
let overlays = 0;
const noticeRegions = () => {
  const toastElement = document.getElementById('toast');
  if (!noticesAsRegions || toastElement.style.display !== 'block') return [];
  const r = toastElement.getBoundingClientRect();
  return [{ x: r.x, y: r.y, width: r.width, height: r.height }];
};
const reportOverlay = () => post({ type: 'overlay', open: overlays > 0, regions: noticeRegions() });
const overlayDelta = (delta) => { overlays = Math.max(0, overlays + delta); reportOverlay(); };

const content = document.getElementById('content');
const reportSlot = () => {
  const r = content.getBoundingClientRect();
  post({ type: 'slot', view: 'threads', rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
};
new ResizeObserver(reportSlot).observe(content);
window.addEventListener('resize', reportSlot);

const dialog = document.getElementById('dialog');
const dialogInput = document.getElementById('dialog-input');
function openDialog() {
  if (dialog.open) return;
  overlayDelta(+1);
  dialog.showModal();
  if (focusMode === 'frame') window.focus();
  dialogInput.focus();
  record('dialog-open', { active: document.activeElement && document.activeElement.id, hasFocus: document.hasFocus() });
}
dialog.addEventListener('close', () => { record('dialog-close'); overlayDelta(-1); });
document.getElementById('dialog-close').addEventListener('click', () => dialog.close());
document.getElementById('open-dialog').addEventListener('click', openDialog);
document.getElementById('frame-btn').addEventListener('click', () => { record('frame-btn-click'); post({ type: 'record', message: 'frame-btn-click' }); });
document.getElementById('in-content').addEventListener('click', () => { record('in-content-click'); post({ type: 'record', message: 'in-content-click' }); });
document.getElementById('toggle-narrow').addEventListener('click', () => { document.body.classList.toggle('narrow'); });

const toast = document.getElementById('toast');
document.getElementById('show-toast').addEventListener('click', () => {
  if (toast.style.display === 'block') return;
  toast.style.display = 'block'; record('toast-open');
  if (noticesAsRegions) reportOverlay(); else overlayDelta(+1);
});
document.getElementById('toast-action').addEventListener('click', () => {
  record('toast-action'); toast.style.display = 'none';
  if (noticesAsRegions) reportOverlay(); else overlayDelta(-1);
});

window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== hostOrigin) return;
  const data = event.data;
  if (!data || data.source !== 'threadkeeper-shell' || data.v !== 1) return;
  if (data.type === 'hello') { parentOrigin = event.origin; post({ type: 'ready' }); reportSlot(); }
  else if (event.origin !== parentOrigin) return;
  else if (data.type === 'command' && data.name === 'palette') openDialog();
});
