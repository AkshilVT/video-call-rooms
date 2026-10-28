// Drives the host console (index.html) inside the running fused-render shell.
// Starts the real server on the configured port via ctl.py, creates a meeting, stops it.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.FUSED_RENDER_ORIGIN || "http://127.0.0.1:1777";
const PAGE = path.resolve(here, "..", "index.html");
const EMBED = `${ORIGIN}/explorer/embed${PAGE}`;
mkdirSync(path.join(here, "artifacts"), { recursive: true });
const failures = [];
const check = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitText(page, sel, re, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const t = await page.locator(sel).first().textContent().catch(() => ""); if (re.test(t || "")) return t; if (Date.now() - t0 > ms) throw new Error(`timeout waiting ${sel} ~ ${re} (last: ${t})`); await sleep(300); }
}
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("dialog", (d) => d.accept());
try {
  // preview mode must stay static
  await page.goto(EMBED + "?_preview=1");
  await sleep(1500);
  const frame = page.frames().find((f) => f.url().includes("index.html")) || page.mainFrame();
  check(await frame.locator("#preview-note").isVisible(), "preview mode shows static placeholder");
  check(!/Running|Stopped/.test(await frame.locator("#pill").textContent()), "preview mode does not call ctl.py");

  await page.goto(EMBED);
  await page.waitForLoadState("networkidle");
  const f = page.frames().find((fr) => fr.url().includes("index.html")) || page.mainFrame();
  await waitText(f, "#pill", /Stopped|Running/);
  check(true, "console loaded with live status: " + (await f.locator("#pill").textContent()));
  if (/Running/.test(await f.locator("#pill").textContent())) { await f.click("#btn-stop"); await waitText(f, "#pill", /Stopped/); }
  await f.click("#btn-start");
  await waitText(f, "#pill", /Running on port \d+/);
  check(true, "Start → " + (await f.locator("#pill").textContent()));
  check((await f.locator("#local-url").textContent()).startsWith("http://127.0.0.1:"), "local URL shown");
  await f.fill("#new-label", "Console test");
  await f.click("#btn-new");
  await waitText(f, "#rooms-body", /Console test/);
  check(true, "New meeting appears in table");
  const code = await f.locator("#rooms-body td.code").first().textContent();
  check(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code), "generated code looks right: " + code);
  const localUrl = await f.locator("#local-url").textContent();
  const info = await fetch(`${localUrl}/api/rooms/${code}`).then((r) => r.json());
  check(info.exists === true, "server knows the new room");
  await page.screenshot({ path: path.join(here, "artifacts", "console-running.png"), fullPage: true });
  // settings round-trip
  await f.fill("#s-serverName", "Console Rooms");
  await f.click("#btn-save");
  await waitText(f, "#save-note", /Saved/);
  const cfg = await fetch(`${localUrl}/api/config`).then((r) => r.json());
  check(cfg.serverName === "Console Rooms", "settings saved and hot-reloaded into server");
  await f.fill("#s-serverName", "Rooms"); await f.click("#btn-save"); await waitText(f, "#save-note", /Saved/);
  // end meeting
  await f.locator("#rooms-body button", { hasText: "End" }).first().click();
  await sleep(1500);
  const after = await fetch(`${localUrl}/api/rooms/${code}`).then((r) => r.json());
  check(after.exists === false, "End meeting removes the room");
  await f.click("#btn-stop");
  await waitText(f, "#pill", /Stopped/);
  check(true, "Stop → Stopped");
  await page.screenshot({ path: path.join(here, "artifacts", "console-stopped.png"), fullPage: true });
  check(errors.length === 0, "no console/page errors" + (errors.length ? " -> " + errors.join(" | ") : ""));
} catch (e) {
  failures.push("exception: " + e.message); console.log("EXCEPTION", e);
  await page.screenshot({ path: path.join(here, "artifacts", "console-fail.png"), fullPage: true }).catch(() => {});
} finally { await browser.close(); }
console.log(failures.length ? "FAILED\n - " + failures.join("\n - ") : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
