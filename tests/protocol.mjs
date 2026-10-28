// Protocol-level tests against server.py with raw sockets: join ordering under a storm,
// fragment flood, request smuggling after bad POSTs, reconnect tokens, odd admin tokens.
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PORT = 18784, BASE = `http://127.0.0.1:${PORT}`, WS = `ws://127.0.0.1:${PORT}/ws`;
const failures = [];
const check = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(tmpdir(), "rooms-proto-"));
const server = spawn("python3", [path.join(root, "server.py"), "--port", String(PORT), "--data", path.join(tmp, "data"), "--log", path.join(tmp, "server.log")], { env: { ...process.env, ROOMS_ADMIN_TOKEN: "t" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res) => server.stdout.on("data", (d) => String(d).includes("READY") && res()));

function client(name, room, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS); const inbox = []; const waiters = [];
    ws.onmessage = (e) => { inbox.push(JSON.parse(e.data)); waiters.splice(0).forEach((w) => w()); };
    ws.onerror = () => reject(new Error("ws error " + name));
    ws.onclose = (e) => { inbox.push({ type: "__closed", code: e.code }); waiters.splice(0).forEach((w) => w()); };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", room, name, state: { mic: true, cam: true, screen: false, hand: false }, ...extra }));
      resolve({ ws, inbox, name, send: (o) => ws.send(JSON.stringify(o)),
        wait: (pred, ms = 3000) => new Promise((res, rej) => { const t0 = Date.now(); const chk = () => { const i = inbox.findIndex(pred); if (i >= 0) return res(inbox.splice(i, 1)[0]); if (Date.now() - t0 > ms) return rej(new Error(name + " timeout; inbox=" + JSON.stringify(inbox).slice(0, 300))); waiters.push(chk); }; chk(); }) });
    };
  });
}
// raw TCP helpers
function rawRequest(bytes, { waitMs = 800 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1"); const chunks = []; let closed = false;
    sock.on("data", (d) => chunks.push(d)); sock.on("close", () => { closed = true; });
    sock.on("connect", () => sock.write(bytes));
    setTimeout(() => { const out = Buffer.concat(chunks).toString("latin1"); sock.destroy(); resolve({ out, closed }); }, waitMs);
  });
}
function frame(opcode, payload, fin) {
  const mask = Buffer.from([1, 2, 3, 4]); const p = Buffer.from(payload); const masked = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i & 3];
  let head;
  if (p.length < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | p.length]);
  else { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  return Buffer.concat([head, mask, masked]);
}
const HANDSHAKE = `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;

try {
  // ---- 1. basics + reconnect token ----------------------------------------
  const a = await client("Alice", "proto-room"); const wa = await a.wait((m) => m.type === "welcome");
  check(typeof wa.token === "string" && wa.token.length >= 16, "welcome carries a resume token");
  const b = await client("Bob", "proto-room"); const wb = await b.wait((m) => m.type === "welcome");
  await a.wait((m) => m.type === "peer-joined");
  const hijack = await client("Mallory", "proto-room", { id: wa.id, token: "wrong" });
  const wh = await hijack.wait((m) => m.type === "welcome");
  check(wh.id !== wa.id, "join with someone else's id but no token gets a fresh id (no hijack)");
  check(a.inbox.every((m) => m.type !== "__closed"), "victim was not disconnected");
  const b2 = await client("Bob", "proto-room", { id: wb.id, token: wb.token });
  const wb2 = await b2.wait((m) => m.type === "welcome");
  check(wb2.id === wb.id, "reconnect with the right token keeps the id");
  const closedOld = await b.wait((m) => m.type === "__closed", 3000); check(closedOld.code === 4000, "old socket closed with 4000");
  a.send({ type: "chat", text: "hi" }); await a.wait((m) => m.type === "chat");
  hijack.send({ type: "leave" }); b2.send({ type: "leave" }); a.send({ type: "leave" }); await sleep(300);

  // ---- 2. join storm: every pair sees exactly one 'welcome' direction -----
  const N = 8; const storm = await Promise.all(Array.from({ length: N }, (_, i) => client("S" + i, "storm-room")));
  await sleep(1500);
  const welcomes = storm.map((c) => c.inbox.find((m) => m.type === "welcome"));
  check(welcomes.every(Boolean), "all 8 storm clients got a welcome");
  let pairsOk = true, joinedOk = true;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const iSeesJ = welcomes[i].peers.some((p) => p.id === welcomes[j].id), jSeesI = welcomes[j].peers.some((p) => p.id === welcomes[i].id);
    if (iSeesJ === jSeesI) pairsOk = false;
    const later = iSeesJ ? i : j, earlier = iSeesJ ? j : i;   // the later joiner lists the earlier one
    if (!storm[earlier].inbox.some((m) => m.type === "peer-joined" && m.peer.id === welcomes[later].id)) joinedOk = false;
  }
  check(pairsOk, "for every pair exactly one side lists the other in its welcome (no double/zero offerer)");
  check(joinedOk, "the earlier side of every pair received peer-joined for the later one");
  const st = await fetch(`${BASE}/api/status`, { headers: { "X-Admin-Token": "t" } }).then((r) => r.json());
  check(st.rooms.find((r) => r.code === "storm-room").peers.length === N, "server sees all 8 peers");
  storm.forEach((c) => c.send({ type: "leave" })); await sleep(300);

  // ---- 3. fragment flood is cut off quickly -------------------------------
  const flood = Buffer.concat([Buffer.from(HANDSHAKE), frame(0x1, "", false), ...Array.from({ length: 5000 }, () => frame(0x0, "", false))]);
  const t0 = Date.now();
  const fl = await rawRequest(flood, { waitMs: 1500 });
  check(fl.out.includes("101 Switching") && (fl.closed || fl.out.includes("\x88")), "zero-length fragment flood → connection closed with 1009 within " + (Date.now() - t0) + " ms");
  const cfgT = Date.now(); const cfg = await fetch(`${BASE}/api/config`).then((r) => r.status);
  check(cfg === 200 && Date.now() - cfgT < 1000, "server still responsive after the flood (" + (Date.now() - cfgT) + " ms)");

  // ---- 4. no request smuggling after rejected POSTs ------------------------
  const smuggle = `POST /nope HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\n0123456789GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n`;
  const sm = await rawRequest(Buffer.from(smuggle));
  check(sm.out.split("HTTP/1.1 ").length - 1 === 1 && sm.out.includes("404") && /connection: close/i.test(sm.out), "POST to non-API path: single 404 with Connection: close (no smuggled GET)");
  const big = `POST /api/rooms HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"a":1}GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n`;
  const bg = await rawRequest(Buffer.from(big));
  check(bg.out.includes("400") && /connection: close/i.test(bg.out) && bg.out.split("HTTP/1.1 ").length - 1 === 1, "oversize body: 400 + close, nothing parsed after it");
  const chunked = `POST /api/rooms HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`;
  const ch = await rawRequest(Buffer.from(chunked));
  check(ch.out.includes("400") && /chunked/.test(ch.out), "chunked POST rejected with 400");
  const keep = await rawRequest(Buffer.from(`GET /healthz HTTP/1.1\r\nHost: x\r\n\r\nGET /healthz HTTP/1.1\r\nHost: x\r\n\r\n`));
  check(keep.out.split("HTTP/1.1 200").length - 1 === 2, "normal keep-alive pipelining still works (2 responses)");

  // ---- 5. odd admin tokens never crash the handler ------------------------
  const odd = await rawRequest(Buffer.from(`GET /api/status HTTP/1.1\r\nHost: x\r\nX-Admin-Token: t\xf6k\xe9n\r\n\r\n`, "latin1"));
  check(odd.out.includes("401"), "non-ASCII admin token → 401, not a reset");
  const okTok = await fetch(`${BASE}/api/status`, { headers: { "X-Admin-Token": "t" } });
  check(okTok.status === 200, "correct token still works");
  // bad TURN settings never break config
  const r = await fetch(`${BASE}/api/config`).then((r) => r.json());
  check(Array.isArray(r.iceServers) && r.iceServers.every((s) => !s.urls.some((u) => u.startsWith("turn")) || (s.username && s.credential)), "no credential-less TURN entry is ever handed to clients");
  // non-join first message / junk
  const junk = await rawRequest(Buffer.concat([Buffer.from(HANDSHAKE), frame(0x1, "not json", true)]));
  check(junk.out.includes("bad-join"), "junk first message → bad-join error");
} catch (e) { failures.push("exception: " + e.message); console.log("EXCEPTION", e); }
finally { server.kill("SIGTERM"); }
console.log(failures.length ? "FAILED\n - " + failures.join("\n - ") : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
