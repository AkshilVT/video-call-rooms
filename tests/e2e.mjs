// End-to-end test: real Chromium peers with fake media against server.py.
// Run: node e2e.mjs [--headed] [--firefox] [--webkit]
import { chromium, firefox, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = new Set(process.argv.slice(2));
const HEADED = args.has("--headed");
const PORT = 18777;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = "e2e-test-room";
const tmp = mkdtempSync(path.join(tmpdir(), "rooms-e2e-"));
mkdirSync(path.join(here, "artifacts"), { recursive: true });
const failures = [];
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
function check(cond, msg) { if (cond) log("  ok  ", msg); else { log("  FAIL", msg); failures.push(msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, msg, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout: " + msg);
    await sleep(250);
  }
}

// ---- server -------------------------------------------------------------
const server = spawn("python3", [path.join(root, "server.py"), "--port", String(PORT), "--data", path.join(tmp, "data"), "--log", path.join(tmp, "server.log")],
  { env: { ...process.env, ROOMS_ADMIN_TOKEN: "e2e-token" }, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => { if (String(d).includes("READY")) resolve(); });
  server.stderr.on("data", (d) => process.stderr.write(d));
  server.on("exit", (c) => reject(new Error("server exited " + c)));
  setTimeout(() => reject(new Error("server start timeout")), 8000);
});
log("server ready on", BASE);

const chromeArgs = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen", "--autoplay-policy=no-user-gesture-required"];
const browser = await chromium.launch({ headless: !HEADED, channel: "chromium", args: chromeArgs });
const pages = [];
async function openPeer(name, br = browser, opts = {}) {
  const ctx = await br.newContext({ viewport: { width: 1200, height: 800 }, ...opts });
  if (br === browser) await ctx.grantPermissions(["camera", "microphone"], { origin: BASE });
  const page = await ctx.newPage();
  page.__name = name; page.__errors = [];
  page.on("pageerror", (e) => { page.__errors.push(String(e)); log(`  [${name} pageerror]`, e.message); });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") log(`  [${name} console.${m.type()}]`, m.text()); });
  await page.goto(`${BASE}/r/${ROOM}`);
  await page.fill("#name", name);
  await page.click("#join");
  await page.waitForSelector("#call:not(.hidden)", { timeout: 15000 });
  pages.push(page);
  log(`${name} joined`);
  return page;
}
const peerIds = (page) => page.evaluate(() => [...window.__roomsDebug.peers.keys()]);
const connStates = (page) => page.evaluate(() => [...window.__roomsDebug.peers.values()].map((p) => [p.name, p.pc.connectionState]));
async function allConnected(page, n) {
  const st = await connStates(page);
  return st.length === n && st.every(([, s]) => s === "connected");
}
async function inboundVideo(page, peerName) {
  return page.evaluate(async (peerName) => {
    const p = [...window.__roomsDebug.peers.values()].find((x) => x.name === peerName);
    if (!p) return null;
    const rep = await p.pc.getStats();
    const out = { frames: 0, audioBytes: 0, screenFrames: 0, codec: "" };
    const codecs = {};
    rep.forEach((r) => { if (r.type === "codec") codecs[r.id] = r.mimeType; });
    rep.forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "video") {
        const isScreen = p.tracks.screen && r.trackIdentifier === p.tracks.screen.id;
        if (isScreen) out.screenFrames += r.framesDecoded || 0; else { out.frames += r.framesDecoded || 0; out.codec = codecs[r.codecId] || ""; }
      }
      if (r.type === "inbound-rtp" && r.kind === "audio") out.audioBytes += r.bytesReceived || 0;
    });
    return out;
  }, peerName);
}
const tileFor = (page, name) => page.locator(".tile", { has: page.locator(".tile-name", { hasText: name }) }).first();

try {
  // 1. two peers connect and exchange media
  const A = await openPeer("Alice");
  const B = await openPeer("Bob");
  await waitFor(() => allConnected(A, 1), "A connected to B");
  await waitFor(() => allConnected(B, 1), "B connected to A");
  check(true, "A<->B connected");
  const vid = await waitFor(async () => { const s = await inboundVideo(B, "Alice"); return s && s.frames > 5 && s.audioBytes > 0 ? s : false; }, "B decoding A's video/audio");
  check(vid.frames > 5, `B decoded ${vid.frames} camera frames from A (codec ${vid.codec})`);
  check(vid.audioBytes > 0, `B received ${vid.audioBytes} audio bytes from A`);
  check(/H264/i.test(vid.codec), "camera negotiated H.264 (hardware-friendly)");
  check((await A.locator("#grid .tile:not(.hidden)").count()) === 2, "A shows 2 tiles");

  // 2. chat both ways + unread badge + history for late joiner
  await A.click("#btn-chat");
  await A.fill("#chat-input", "hello from Alice https://example.com");
  await A.press("#chat-input", "Enter");
  await waitFor(() => B.locator(".msg-body", { hasText: "hello from Alice" }).count(), "B received chat");
  check(true, "chat A -> B delivered");
  check((await B.locator("#chat-badge").textContent()) === "1", "B unread badge = 1 while panel closed");
  check((await B.locator(".msg-body a").count()) === 1, "URL linkified");
  await B.click("#btn-chat");
  check((await B.locator("#chat-badge").textContent()) === "", "opening chat clears unread");
  await B.fill("#chat-input", "hi back");
  await B.press("#chat-input", "Enter");
  await waitFor(() => A.locator(".msg-body", { hasText: "hi back" }).count(), "A received reply");
  check(true, "chat B -> A delivered");

  // 3. mute / camera off propagate
  await A.click("#btn-mic");
  await waitFor(async () => (await tileFor(B, "Alice").getAttribute("class")).includes("mic-off"), "B sees A muted");
  check(true, "mute state propagated");
  await A.click("#btn-cam");
  await waitFor(async () => (await tileFor(B, "Alice").getAttribute("class")).includes("cam-off"), "B sees A cam off");
  check(true, "camera-off state propagated");
  await A.click("#btn-cam");
  await waitFor(async () => !(await tileFor(B, "Alice").getAttribute("class")).includes("cam-off"), "B sees A cam back on");
  const before = (await inboundVideo(B, "Alice")).frames;
  await sleep(1500);
  check((await inboundVideo(B, "Alice")).frames > before, "camera frames resume after toggling back on");
  await A.click("#btn-mic");

  // 4. keyboard shortcut
  await A.keyboard.press("Meta+d");
  await waitFor(async () => (await A.getAttribute("#btn-mic", "aria-pressed")) === "false", "⌘D mutes");
  await A.keyboard.press("Meta+d");
  check((await A.getAttribute("#btn-mic", "aria-pressed")) === "true", "⌘D toggles mic");

  // 5. screen share -> stage on remote
  await A.click("#btn-share");
  let shared = false;
  try {
    await waitFor(() => B.locator("#stage video").count(), "B stage shows A's screen", 10000);
    const sf = await waitFor(async () => { const s = await inboundVideo(B, "Alice"); return s.screenFrames > 3 ? s : false; }, "B decodes screen frames", 10000);
    check(sf.screenFrames > 3, `B decoded ${sf.screenFrames} screen-share frames`);
    check((await B.locator("#stage .stage-label").textContent()).includes("presenting"), "stage label says presenting");
    check((await A.locator("#stage .self-share").count()) === 1, "A shows 'You're presenting' card");
    shared = true;
    await A.click("#stage .self-share button");
    await waitFor(async () => (await B.locator("#stage").getAttribute("class")).includes("hidden"), "stage hides after stop");
    check(true, "stop presenting clears stage");
  } catch (e) {
    const st = await A.evaluate(() => window.__roomsDebug.state.screen);
    check(false, `screen share: ${e.message} (A.state.screen=${st}; headless getDisplayMedia may be unsupported — rerun with --headed)`);
  }

  // 6. third peer -> full mesh; raise hand; pin
  const C = await openPeer("Cara");
  await waitFor(() => allConnected(C, 2), "C connected to A and B");
  await waitFor(() => allConnected(A, 2), "A connected to B and C");
  check(true, "3-way mesh connected");
  check((await C.locator(".msg-body", { hasText: "hello from Alice" }).count()) === 1, "late joiner got chat history");
  check((await A.locator("#people-badge").textContent()) === "3", "participant badge = 3");
  await C.click("#btn-hand");
  await waitFor(async () => (await tileFor(A, "Cara").getAttribute("class")).includes("hand"), "A sees C's hand");
  check(true, "raise hand propagated");
  await tileFor(A, "Bob").click();
  await waitFor(() => A.locator("#stage video").count(), "pin shows stage");
  check((await A.locator("#media").getAttribute("class")).includes("staged"), "pinning a tile enters stage layout");
  await A.click("#stage .tile-pin");
  check(!(await A.locator("#media").getAttribute("class")).includes("staged"), "unpin returns to grid");
  const enc = await A.evaluate(() => { const p = [...window.__roomsDebug.peers.values()][0]; return p.tx.cam.sender.getParameters().encodings[0]; });
  check(enc.scaleResolutionDownBy === 1 && enc.maxBitrate === 812500 && enc.maxFramerate === 24, `sender params applied at 3 people (scale=${enc.scaleResolutionDownBy} bitrate=${enc.maxBitrate} fps=${enc.maxFramerate})`);

  // 7. leave propagates
  await B.click("#btn-leave");
  await waitFor(async () => (await peerIds(A)).length === 1, "A sees B leave");
  check((await A.locator("#grid .tile:not(.hidden)").count()) === 2, "A back to 2 tiles after B leaves");
  check((await B.locator("#left:not(.hidden)").count()) === 1, "B sees left screen");
  check((await A.locator(".msg.sys", { hasText: "Bob left" }).count()) === 1, "system message on leave");

  // 8. reload = rejoin (name remembered)
  await A.reload();
  check((await A.inputValue("#name")) === "Alice", "name remembered after reload");
  await A.click("#join");
  await A.waitForSelector("#call:not(.hidden)");
  await waitFor(() => allConnected(A, 1), "A reconnected to C after reload");
  await waitFor(() => allConnected(C, 1), "C connected to reloaded A");
  check(true, "rejoin after reload works");

  // 9. room full + admin close
  const status = await fetch(`${BASE}/api/status`, { headers: { "X-Admin-Token": "e2e-token" } }).then((r) => r.json());
  check(status.rooms.find((r) => r.code === ROOM).peers.length === 2, "admin status lists 2 peers");
  await fetch(`${BASE}/api/admin/rooms/${ROOM}/close`, { method: "POST", headers: { "X-Admin-Token": "e2e-token" } });
  await waitFor(() => C.locator("#left:not(.hidden)").count(), "C kicked to left screen on close");
  check((await C.locator("#left-title").textContent()).includes("ended"), "close shows 'Meeting ended'");

  // 10. landing page
  const L = await browser.newPage();
  await L.goto(BASE + "/");
  await L.click("#new");
  await L.waitForURL(/\/r\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  check(true, "landing 'New meeting' creates a coded room: " + new URL(L.url()).pathname);
  await L.close();

  for (const p of pages) check(p.__errors.length === 0, `${p.__name}: no page errors` + (p.__errors.length ? " -> " + p.__errors.join(" | ") : ""));
  if (!shared && !HEADED) log("note: screen share could not be exercised headless");

  // ---- cross-engine (optional) ----------------------------------------
  if (args.has("--firefox")) {
    const ff = await firefox.launch({ headless: !HEADED, firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0 } });
    const A2 = await openPeer("Chrome");
    const F = await openPeer("Fox", ff);
    try {
      await waitFor(() => allConnected(F, 1), "Firefox connected to Chrome", 20000);
      await waitFor(() => allConnected(A2, 1), "Chrome connected to Firefox", 20000);
      const s1 = await waitFor(async () => { const s = await inboundVideo(A2, "Fox"); return s.frames > 3 && s.audioBytes > 0 ? s : false; }, "Chrome decodes Firefox video", 20000);
      const s2 = await waitFor(async () => { const s = await inboundVideo(F, "Chrome"); return s.frames > 3 && s.audioBytes > 0 ? s : false; }, "Firefox decodes Chrome video", 20000);
      check(true, `Chrome<->Firefox media both ways (codecs ${s1.codec} / ${s2.codec})`);
      await F.click("#btn-chat"); await F.fill("#chat-input", "from firefox"); await F.press("#chat-input", "Enter");
      await waitFor(() => A2.locator(".msg-body", { hasText: "from firefox" }).count(), "chat from firefox");
      check(true, "Firefox chat delivered");
      check(F.__errors.length === 0, "Firefox: no page errors");
    } catch (e) { check(false, "firefox interop: " + e.message); }
    await ff.close();
  }
  if (args.has("--webkit")) {
    const wk = await webkit.launch({ headless: !HEADED });
    const ctx = await wk.newContext();
    const W = await ctx.newPage(); W.__errors = [];
    W.on("pageerror", (e) => W.__errors.push(String(e)));
    await W.goto(`${BASE}/r/${ROOM}`);
    await W.waitForSelector("#lobby");
    await sleep(1500);
    check(W.__errors.length === 0, "WebKit lobby renders without page errors" + (W.__errors.length ? " -> " + W.__errors.join(" | ") : ""));
    await W.fill("#name", "Safari"); await W.click("#join");
    try { await W.waitForSelector("#call:not(.hidden)", { timeout: 10000 }); check(true, "WebKit joins the call"); } catch (e) { check(false, "WebKit join: " + e.message); }
    await W.screenshot({ path: path.join(here, "artifacts", "webkit.png") });
    await wk.close();
  }
  for (const p of pages) { try { await p.screenshot({ path: path.join(here, "artifacts", `${p.__name}.png`) }); } catch (e) { /* closed */ } }
} catch (e) {
  failures.push("exception: " + e.message);
  log("EXCEPTION", e);
  for (const p of pages) { try { await p.screenshot({ path: path.join(here, "artifacts", `fail-${p.__name}.png`) }); } catch (err) { /* ignore */ } }
} finally {
  await browser.close().catch(() => {});
  server.kill("SIGTERM");
}
log(failures.length ? `FAILED (${failures.length})\n - ` + failures.join("\n - ") : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
