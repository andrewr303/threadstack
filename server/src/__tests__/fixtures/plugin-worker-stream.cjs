const readline = require("node:readline");
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { ok: true, supportedMethods: ["getData"] } });
  if (request.method === "getData") {
    const scope = { paperclipInvocationId: request.paperclipInvocation?.id };
    const companyId = request.params.params.companyId;
    send({ jsonrpc: "2.0", method: "streams.emit", params: { channel: "sessions", companyId: "foreign-company", event: { type: "forged" } }, ...scope });
    send({ jsonrpc: "2.0", method: "streams.open", params: { channel: "sessions", companyId }, ...scope });
    send({ jsonrpc: "2.0", method: "streams.emit", params: { channel: "sessions", companyId, event: { type: "changed", source: "real-child-process" } }, ...scope });
    return send({ jsonrpc: "2.0", id: request.id, result: { emitted: true } });
  }
  if (request.method === "shutdown") { send({ jsonrpc: "2.0", id: request.id, result: {} }); setImmediate(() => process.exit(0)); }
});
