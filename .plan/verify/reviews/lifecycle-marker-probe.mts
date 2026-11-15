import { createPaperclipLifecycle } from '/Users/andrew/dev/threadkeeper/paperclip/extension/src/core/paperclip/lifecycle.ts';
import { agentData } from '/Users/andrew/dev/threadkeeper/paperclip/packages/plugins/plugin-browser-sessions/src/tools.ts';
let starts = 0;
const lifecycle = createPaperclipLifecycle({ origin: 'http://127.0.0.1:3100', hasAccess: async () => true,
  fetch: async () => new Response('<html>Another app</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  helper: { status: async () => ({ ok: true, paperclip: { service: 'stopped' } }), start: async () => { starts++; return { ok: true, started: true }; } } });
lifecycle.setVisible(true);
await new Promise(resolve => setTimeout(resolve, 40));
console.log(JSON.stringify({ lifecycle: lifecycle.getSnapshot(), startRequests: starts, readData: agentData({ messages: [{ text: 'fixture' }] }) }));
lifecycle.dispose();
if (starts !== 0) throw new Error('A non-Paperclip HTTP responder must not trigger a service start');
