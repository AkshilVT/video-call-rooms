// Edge cases: 6-person mesh (auto-downscale), allowCreate=false, room-full message in lobby.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const failures = [];
const check = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startServer(port, settings) {
  const tmp = mkdtempSync(path.join(tmpdir(), "rooms-edge-")); mkdirSync(path.join(tmp, "data"));
  if (settings) writeFileSync(path.join(tmp, "data", "settings.json"), JSON.stringify(settings));
  const srv = spawn("python3", [path.join(root, "server.py"), "--port", String(port), "--data", path.join(tmp, "data")], { env: { ...process.env, ROOMS_ADMIN_TOKEN: "t" }, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((res) => srv.stdout.on("data", (d) => String(d).includes("READY") && res()));
  return srv;
}
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
async function open(base, room, name) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } }); await ctx.grantPermissions(["camera", "microphone"], { origin: base });
  const p = await ctx.newPage(); p.__errors = []; p.on("pageerror", (e) => p.__errors.push(String(e)));
  await p.goto(`${base}/r/${room}`); await p.fill("#name", name); return p;
}
const allConnected = (p, n) => p.evaluate((n) => window.__roomsDebug.peers.size === n && [...window.__roomsDebug.peers.values()].every((x) => x.pc.connectionState === "connected"), n);
async function waitFor(fn, msg, timeout = 30000) { const t0 = Date.now(); while (!(await fn().catch(() => false))) { if (Date.now() - t0 > timeout) throw new Error("timeout: " + msg); await sleep(300); } }
try {
  // ---- 1. six people -------------------------------------------------------
  const s1 = await startServer(18781); const B1 = "http://127.0.0.1:18781";
  const pages = [];
  for (let i = 0; i < 6; i++) { const p = await open(B1, "big-room", "P" + (i + 1)); await p.click("#join"); await p.waitForSelector("#call:not(.hidden)"); pages.push(p); }
  await waitFor(async () => { for (const p of pages) if (!(await allConnected(p, 5))) return false; return true; }, "6-way mesh connected", 45000);
  check(true, "6-person mesh: all 15 connections connected");
  await sleep(1500);
  const enc = await pages[0].evaluate(() => [...window.__roomsDebug.peers.values()].map((p) => p.tx.cam.sender.getParameters().encodings[0].scaleResolutionDownBy));
  check(enc.every((s) => s === 1.5), "6 people → camera scaleResolutionDownBy 1.5 on every sender (" + enc.join(",") + ")");
  const tiles = await pages[0].locator("#grid .tile:not(.hidden)").count();
  check(tiles === 6, "6 tiles laid out (" + tiles + ")");
  const frames = await pages[5].evaluate(async () => { let f = 0; for (const p of window.__roomsDebug.peers.values()) { const rep = await p.pc.getStats(); rep.forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "video") f += r.framesDecoded || 0; }); } return f; });
  check(frames > 25, "last joiner decodes video from all five (" + frames + " frames)");
  // audio-only mode pauses incoming camera encodings on the senders
  await pages[0].click("#btn-more"); await pages[0].check("#set-audioonly"); await pages[0].keyboard.press("Escape"); await sleep(800);
  const paused = await pages[1].evaluate(() => { const me = [...window.__roomsDebug.peers.values()].find((p) => p.name === "P1"); return me.tx.cam.sender.getParameters().encodings[0].active; });
  check(paused === false, "audio-only on P1 → P2 stops encoding camera for P1 (active=false)");
  await pages[0].click("#btn-more"); await pages[0].uncheck("#set-audioonly"); await pages[0].keyboard.press("Escape"); await sleep(800);
  const resumed = await pages[1].evaluate(() => { const me = [...window.__roomsDebug.peers.values()].find((p) => p.name === "P1"); return me.tx.cam.sender.getParameters().encodings[0].active; });
  check(resumed === true, "audio-only off → encoding resumes (active=true)");
  // one leaves → scale back to 1 at 5 people
  await pages[5].click("#btn-leave"); await sleep(1200);
  const enc2 = await pages[0].evaluate(() => [...window.__roomsDebug.peers.values()].map((p) => p.tx.cam.sender.getParameters().encodings[0].scaleResolutionDownBy));
  check(enc2.length === 4 && enc2.every((s) => s === 1.5), "5 people → still 1.5 (" + enc2.join(",") + ")");
  await pages[4].click("#btn-leave"); await sleep(1200);
  const enc3 = await pages[0].evaluate(() => [...window.__roomsDebug.peers.values()].map((p) => p.tx.cam.sender.getParameters().encodings[0].scaleResolutionDownBy));
  check(enc3.length === 3 && enc3.every((s) => s === 1), "4 people → back to full resolution (" + enc3.join(",") + ")");
  check(pages.every((p) => p.__errors.length === 0), "no page errors across 6 peers");
  for (const p of pages) await p.context().close();
  s1.kill();

  // ---- 2. allowCreate=false + maxPeers=2 --------------------------------
  const s2 = await startServer(18782, { allowCreate: false, maxPeers: 2 }); const B2 = "http://127.0.0.1:18782";
  const admin = await fetch(`${B2}/api/admin/rooms`, { method: "POST", headers: { "X-Admin-Token": "t", "Content-Type": "application/json" }, body: JSON.stringify({ code: "team", label: "Team" }) }).then((r) => r.json());
  check(admin.ok, "host can still create rooms via admin API");
  const pub = await fetch(`${B2}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(pub.status === 403, "public room creation refused (" + pub.status + ")");
  const nf = await open(B2, "nope-nope", "Guest"); await sleep(800);
  check(/not found/i.test(await nf.locator("#lobby-title").textContent()) && (await nf.locator("#join").isDisabled()), "unknown code → 'Meeting not found', Join disabled");
  const landing = await browser.newPage(); await landing.goto(B2 + "/"); await sleep(500);
  check(await landing.locator("#new").isHidden(), "landing hides 'New meeting' when creation is off");
  const g1 = await open(B2, "team", "One"); await g1.click("#join"); await g1.waitForSelector("#call:not(.hidden)");
  const g2 = await open(B2, "team", "Two"); await g2.click("#join"); await g2.waitForSelector("#call:not(.hidden)");
  const g3 = await open(B2, "team", "Three");
  check(/2 people are here/.test(await g3.locator("#lobby-meta").textContent()), "lobby shows '2 people are here'");
  await g3.click("#join"); await sleep(2000);
  const hint = await g3.locator("#lobby-hint").textContent();
  check(/full/i.test(hint), "third person sees 'meeting is full' and it is not overwritten: " + JSON.stringify(hint));
  check(!(await g3.locator("#join").isDisabled()) && (await g3.locator("#join").textContent()) === "Join now", "Join button re-enabled after error");
  s2.kill();
} catch (e) { failures.push("exception: " + e.message); console.log("EXCEPTION", e); }
finally { await browser.close(); }
console.log(failures.length ? "FAILED\n - " + failures.join("\n - ") : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
