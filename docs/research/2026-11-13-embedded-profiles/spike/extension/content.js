// Research fixture: what an isolated-world content script can see in each kind of frame.
try {
  // Frames the test names "top-…" are told to answer framing checks like a top-level page. The
  // mark is set before any page script runs and consumed by main.js (the page-world half).
  if (window.name.startsWith('top-') && document.documentElement) document.documentElement.setAttribute('data-spike-top', '');
  chrome.runtime.sendMessage({
    type: 'frameHello',
    // Read in the isolated world, so a page script cannot change the answer.
    credentialless: window.credentialless === true,
    name: window.name,
    hadRoot: Boolean(document.documentElement),
  });
} catch {
  // extension gone
}
