// Real-world path: server + Cloudflare quick tunnel via ctl.py, one peer local, one through the tunnel.
// Opens a public (unguessable) URL for the duration of the test. Run by hand: node tunnel.mjs
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const CTL = path.resolve(here, "..", "ctl.py");
const ctl = (action, extra = []) => JSON.parse(execFileSync("python3", [CTL, action, ...extra], { encoding: "utf-8" }));
const failures = [];
const check = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  let st = ctl("start");
  check(st.ok && st.server.running, "server started via ctl.py on " + st.server.localUrl);
  st = ctl("tunnel_start");
  check(st.ok && st.tunnel.running && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(st.publicUrl || ""), "tunnel up: " + (st.publicUrl || st.error));
  const PUB = st.publicUrl, LOCAL = st.server.localUrl;
  let cfg = null;
  for (let i = 0; i < 30 && !cfg; i++) { try { const r = await fetch(PUB + "/api/config"); if (r.ok) cfg = await r.json(); } catch (e) { /* propagating */ } if (!cfg) await sleep(1000); }
  check(!!cfg, "public URL serves /api/config");
  check(cfg && cfg.publicUrl === PUB, "server knows its public URL for invite links");
  const token = JSON.parse(readFileSync(path.resolve(here, "..", ".fused/data/server.json"), "utf-8")).token;
  const adminViaTunnel = await fetch(PUB + "/api/status", { headers: { "X-Admin-Token": token } });
  check(adminViaTunnel.status === 401, "admin API refused through the tunnel (" + adminViaTunnel.status + ")");

  browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  async function peer(name, base) {
    const ctx = await browser.newContext(); await ctx.grantPermissions(["camera", "microphone"], { origin: base });
    const p = await ctx.newPage(); p.__errors = [];
    p.on("pageerror", (e) => p.__errors.push(String(e)));
    await p.goto(base + "/r/tunnel-test"); await p.fill("#name", name); await p.click("#join");
    await p.waitForSelector("#call:not(.hidden)", { timeout: 20000 }); return p;
  }
  const A = await peer("Local", LOCAL);
  const B = await peer("Remote", PUB);
  check(true, "remote peer joined through the tunnel");
  const connected = async (p) => p.evaluate(() => window.__roomsDebug.peers.size === 1 && [...window.__roomsDebug.peers.values()].every((x) => x.pc.connectionState === "connected"));
  const t0 = Date.now(); while (!(await connected(A) && await connected(B)) && Date.now() - t0 < 20000) await sleep(300);
  check(await connected(A) && await connected(B), "local <-> remote WebRTC connected (signaling via cloudflared)");
  await sleep(2000);
  const frames = await B.evaluate(async () => { const p = [...window.__roomsDebug.peers.values()][0]; const rep = await p.pc.getStats(); let f = 0; rep.forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "video") f += r.framesDecoded || 0; }); return f; });
  check(frames > 5, "remote decodes local video: " + frames + " frames");
  await B.click("#btn-chat"); await B.fill("#chat-input", "through the tunnel"); await B.press("#chat-input", "Enter");
  await A.waitForSelector(".msg-body:has-text('through the tunnel')", { timeout: 5000 });
  check(true, "chat relayed through tunnel");
  const invite = await A.evaluate(() => (window.__roomsDebug.config.publicUrl || location.origin) + "/r/tunnel-test");
  check(invite.startsWith(PUB), "local host's invite link uses the public URL: " + invite);
  check(A.__errors.length === 0 && B.__errors.length === 0, "no page errors");
} catch (e) { failures.push("exception: " + e.message); console.log("EXCEPTION", e); }
finally {
  if (browser) await browser.close();
  const st = ctl("stop");
  check(!st.server.running && !st.tunnel.running, "ctl.py stop shut down server and tunnel");
}
console.log(failures.length ? "FAILED\n - " + failures.join("\n - ") : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
