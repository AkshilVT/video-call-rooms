// Visual QA: screenshots of landing, lobby, 3-person call with chat, screen-share stage.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(here, "artifacts"); mkdirSync(OUT, { recursive: true });
const PORT = 18779, BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), "rooms-shots-"));
const server = spawn("python3", [path.join(root, "server.py"), "--port", String(PORT), "--data", path.join(tmp, "data")], { env: { ...process.env, ROOMS_ADMIN_TOKEN: "t" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res) => server.stdout.on("data", (d) => String(d).includes("READY") && res()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"] });
async function ctx() { const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }); await c.grantPermissions(["camera", "microphone"], { origin: BASE }); return c; }
try {
  const L = await (await ctx()).newPage(); await L.goto(BASE + "/"); await sleep(500); await L.screenshot({ path: path.join(OUT, "01-landing.png") });
  const A = await (await ctx()).newPage(); await A.goto(BASE + "/r/demo-room"); await A.fill("#name", "Akshil"); await sleep(1200); await A.screenshot({ path: path.join(OUT, "02-lobby.png") });
  await A.click("#join"); await A.waitForSelector("#call:not(.hidden)");
  const join = async (name) => { const p = await (await ctx()).newPage(); await p.goto(BASE + "/r/demo-room"); await p.fill("#name", name); await p.click("#join"); await p.waitForSelector("#call:not(.hidden)"); return p; };
  const B = await join("Maria Chen"); const C = await join("Dev");
  await A.waitForFunction(() => window.__roomsDebug.peers.size === 2 && [...window.__roomsDebug.peers.values()].every((p) => p.pc.connectionState === "connected"));
  await sleep(1500);
  await A.screenshot({ path: path.join(OUT, "03-call-3.png") });
  await B.click("#btn-chat"); await B.fill("#chat-input", "Can everyone see my slides? https://docs.example.com/q4"); await B.press("#chat-input", "Enter");
  await C.click("#btn-mic"); await C.click("#btn-hand");
  await A.click("#btn-chat"); await A.fill("#chat-input", "Yes, go ahead"); await A.press("#chat-input", "Enter"); await sleep(800);
  await A.screenshot({ path: path.join(OUT, "04-call-chat.png") });
  await A.click('.panel-tabs [data-tab="people"]'); await sleep(300); await A.screenshot({ path: path.join(OUT, "05-people.png") });
  await A.click("#panel-close");
  await B.click("#btn-share"); await A.waitForSelector("#stage video"); await sleep(1500);
  await A.screenshot({ path: path.join(OUT, "06-stage-remote.png") });
  await B.screenshot({ path: path.join(OUT, "07-stage-self.png") });
  await A.click("#btn-more"); await sleep(300); await A.screenshot({ path: path.join(OUT, "08-settings.png") });
  await A.keyboard.press("Escape");
  await A.setViewportSize({ width: 820, height: 600 }); await sleep(500); await A.screenshot({ path: path.join(OUT, "09-small.png") });
  await A.setViewportSize({ width: 1280, height: 800 });
  await A.click("#btn-leave"); await sleep(300); await A.screenshot({ path: path.join(OUT, "10-left.png") });
  console.log("shots written to", OUT);
} catch (e) { console.log("ERR", e); }
finally { await browser.close(); server.kill(); }
