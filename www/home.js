"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const hint = $("hint");

  function codeFrom(text) {
    text = (text || "").trim();
    const m = text.match(/\/r\/([A-Za-z0-9-]{3,40})/);
    if (m) return m[1].toLowerCase();
    const c = text.toLowerCase().replace(/\s+/g, "");
    return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(c) ? c : "";
  }

  fetch("/api/config").then((r) => r.json()).then((cfg) => {
    $("server-name").textContent = cfg.serverName || "Rooms";
    document.title = cfg.serverName || "Rooms";
    $("max").textContent = cfg.maxPeers;
    if (!cfg.allowCreate) {
      $("new").hidden = true;
      hint.textContent = "Only the host can create meetings here. Paste the link or code you were given.";
    }
  }).catch(() => { hint.textContent = "Server unreachable."; hint.className = "hint error"; });

  $("new").addEventListener("click", async () => {
    $("new").disabled = true;
    try {
      const r = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "could not create");
      location.href = "/r/" + j.room.code;
    } catch (e) {
      hint.textContent = String(e.message || e); hint.className = "hint error"; $("new").disabled = false;
    }
  });

  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = codeFrom($("code").value);
    if (!code) { hint.textContent = "That doesn't look like a meeting code (e.g. abc-defg-hij)."; hint.className = "hint error"; return; }
    location.href = "/r/" + code;
  });
})();
