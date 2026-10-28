/* Rooms — guest client. Plain ES2022, no dependencies.
 * Mesh WebRTC: one RTCPeerConnection per remote peer with three fixed
 * transceivers (mic, camera, screen) so toggling media never renegotiates.
 * Signaling + chat ride one WebSocket to server.py. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const code = (location.pathname.split("/")[2] || "").toLowerCase();
  const ROLES = ["mic", "cam", "screen"];
  const PRESETS = {
    low: { width: 320, height: 180, fps: 15, bitrate: 220000 },
    medium: { width: 640, height: 360, fps: 24, bitrate: 650000 },
    high: { width: 1280, height: 720, fps: 30, bitrate: 1600000 },
  };
  const SHARE_BITRATE = 2500000;
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("rooms." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("rooms." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const prefs = {
    name: LS.get("name", ""), mic: LS.get("mic", true), cam: LS.get("cam", true),
    micId: LS.get("micId", ""), camId: LS.get("camId", ""), spkId: LS.get("spkId", ""),
    camera: LS.get("camera", ""), shareFps: LS.get("shareFps", 0), hideSelf: LS.get("hideSelf", false),
    h264: LS.get("h264", true), sounds: LS.get("sounds", true), audioOnly: false, stats: false,
  };
  const S = {
    phase: "lobby", ws: null, wsTries: 0, reconnectTimer: 0, id: null, token: null, room: null, config: null,
    lastRx: 0, pendingSignals: new Map(), seenChat: new Set(), busy: {}, roomMissing: false,
    local: { mic: null, cam: null, screen: null },
    state: { mic: prefs.mic, cam: prefs.cam, screen: false, hand: false },
    peers: new Map(), pinned: null, presenters: [], unread: 0, joinedAt: 0, leaving: false,
    audioCtx: null, analyser: null, analyserData: null, lastMutedHint: 0, panelOpen: false, panelTab: "chat",
    devices: { mic: [], cam: [], spk: [] }, netLevel: "", lastChatKey: "", lastChatTs: 0,
  };

  // ------------------------------------------------------------------ utils
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const fmtTime = (ms) => { const d = new Date(ms); return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0"); };
  const inviteUrl = () => ((S.config && S.config.publicUrl) || location.origin) + "/r/" + code;
  const preset = () => PRESETS[prefs.camera || (S.config && S.config.camera) || "medium"] || PRESETS.medium;
  const shareFps = () => Number(prefs.shareFps) || (S.config && S.config.shareFps) || 10;
  const maxPeers = () => (S.config && S.config.maxPeers) || 8;
  const hasDisplay = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const canSink = "setSinkId" in HTMLMediaElement.prototype;

  function toast(text, kind, ms) {
    const t = el("div", "toast" + (kind ? " " + kind : ""), text);
    $("toasts").appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); }, ms || 3500);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = el("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; } ta.remove(); return ok;
  }
  function beep(seq) {
    if (!prefs.sounds || !S.audioCtx) return;
    try {
      const ctx = S.audioCtx, t0 = ctx.currentTime;
      seq.forEach(([freq, at, dur]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.08, t0 + at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
        o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
      });
    } catch (e) { /* audio not available */ }
  }
  const sounds = { join: () => beep([[523, 0, 0.12], [659, 0.1, 0.16]]), leave: () => beep([[659, 0, 0.12], [523, 0.1, 0.16]]), chat: () => beep([[880, 0, 0.09]]) };

  // ------------------------------------------------------------- media local
  async function getMic(deviceId) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      return s.getAudioTracks()[0];
    } catch (e) {
      if (deviceId && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) return getMic("");
      throw e;
    }
  }
  async function getCam(deviceId) {
    const p = preset();
    const video = { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps, max: p.fps } };
    if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = "user";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      return s.getVideoTracks()[0];
    } catch (e) {
      if (deviceId && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) return getCam("");
      throw e;
    }
  }
  function stopTrack(t) { if (t) { try { t.stop(); } catch (e) { /* ignore */ } } }
  function watchTrack(track, role) {            // unplugged device / revoked permission
    track.addEventListener("ended", () => {
      if (S.local[role] !== track || S.phase === "left") return;
      S.local[role] = null;
      if (role === "cam") S.state.cam = false; else S.state.mic = false;
      for (const p of S.peers.values()) if (p.tx[role]) p.tx[role].sender.replaceTrack(null).catch(() => {});
      toast(role === "cam" ? "Camera disconnected" : "Microphone disconnected", "warn");
      if (S.analyser && role === "mic") S.analyser = null;
      renderLobby(); renderSelf(); sendState(); layout();
    });
    return track;
  }
  function permissionHint(e) {
    if (!e) return "";
    if (e.name === "NotAllowedError") return "Permission denied. Allow camera/microphone for this site in the address bar, then reload.";
    if (e.name === "NotFoundError") return "No camera or microphone found.";
    if (e.name === "NotReadableError") return "Device is busy in another app.";
    return e.message || String(e);
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
    S.devices = {
      mic: list.filter((d) => d.kind === "audioinput"),
      cam: list.filter((d) => d.kind === "videoinput"),
      spk: list.filter((d) => d.kind === "audiooutput"),
    };
    fillDeviceSelects();
  }
  function fillSelect(sel, devices, current, fallbackLabel) {
    if (!sel) return;
    sel.textContent = "";
    if (!devices.length) { sel.appendChild(new Option(fallbackLabel, "")); sel.disabled = true; return; }
    sel.disabled = false;
    devices.forEach((d, i) => sel.appendChild(new Option(d.label || (fallbackLabel + " " + (i + 1)), d.deviceId)));
    if (current && devices.some((d) => d.deviceId === current)) sel.value = current;
  }
  function fillDeviceSelects() {
    const curMic = (S.local.mic && S.local.mic.getSettings().deviceId) || prefs.micId;
    const curCam = (S.local.cam && S.local.cam.getSettings().deviceId) || prefs.camId;
    ["sel", "set"].forEach((pfx) => {
      fillSelect($(pfx + "-mic"), S.devices.mic, curMic, "Microphone");
      fillSelect($(pfx + "-cam"), S.devices.cam, curCam, "Camera");
      fillSelect($(pfx + "-spk"), S.devices.spk, prefs.spkId, "Default speakers");
    });
    const showSpk = canSink && S.devices.spk.length > 0;
    $("field-spk").classList.toggle("hidden", !showSpk);
    $("set-field-spk").classList.toggle("hidden", !showSpk);
  }

  // ------------------------------------------------------------- lobby
  async function startPreview() {
    const hint = $("lobby-hint");
    const wantMic = S.state.mic, wantCam = S.state.cam;
    let err = null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint.textContent = "This browser can't access camera/microphone here. Open the link over HTTPS (or localhost)."; hint.className = "hint error";
      S.state.mic = false; S.state.cam = false; renderLobby(); return;
    }
    try { S.local.mic = watchTrack(await getMic(prefs.micId), "mic"); S.local.mic.enabled = wantMic; }
    catch (e) { err = e; S.state.mic = false; }
    if (wantCam) {
      try { S.local.cam = watchTrack(await getCam(prefs.camId), "cam"); }
      catch (e) { err = err || e; S.state.cam = false; }
    }
    if (err) { hint.textContent = permissionHint(err); hint.className = "hint error"; }
    await refreshDevices();
    renderLobby();
    for (const p of S.peers.values()) attachLocal(p);   // in case a join raced the preview
  }
  function renderLobby() {
    const v = $("preview-video");
    if (S.local.cam && S.state.cam) { if (v.srcObject !== S.local.cam) v.srcObject = new MediaStream([S.local.cam]); v.classList.remove("hidden"); $("preview-off").classList.add("hidden"); }
    else { v.classList.add("hidden"); $("preview-off").classList.remove("hidden"); }
    $("preview-avatar").textContent = initials($("name").value || prefs.name);
    $("lobby-mic").setAttribute("aria-pressed", String(S.state.mic));
    $("lobby-cam").setAttribute("aria-pressed", String(S.state.cam));
  }
  async function toggleMic() {
    if (S.busy.mic || S.phase === "left") return;
    S.busy.mic = true;
    try {
      if (!S.local.mic && !S.state.mic) {
        let t;
        try { t = await getMic(prefs.micId); } catch (e) { toast(permissionHint(e), "error"); return; }
        if (S.phase === "left") { stopTrack(t); return; }
        S.local.mic = watchTrack(t, "mic");
        for (const p of S.peers.values()) if (p.tx.mic) p.tx.mic.sender.replaceTrack(t).catch(() => {});
        if (S.analyser) { S.analyser = null; setupLocalAnalyser(); }
      }
      S.state.mic = !S.state.mic;
      if (S.local.mic) S.local.mic.enabled = S.state.mic;
      LS.set("mic", S.state.mic);
      renderLobby(); renderSelf(); sendState();
    } finally { S.busy.mic = false; }
  }
  async function toggleCam() {
    if (S.busy.cam || S.phase === "left") return;
    S.busy.cam = true;
    try {
      if (S.state.cam) {
        S.state.cam = false;
        const t = S.local.cam; S.local.cam = null; stopTrack(t);
        for (const p of S.peers.values()) if (p.tx.cam) p.tx.cam.sender.replaceTrack(null).catch(() => {});
      } else {
        let t;
        try { t = await getCam(prefs.camId); } catch (e) { toast(permissionHint(e), "error"); return; }
        if (S.phase === "left") { stopTrack(t); return; }
        S.local.cam = watchTrack(t, "cam");
        S.state.cam = true;
        for (const p of S.peers.values()) if (p.tx.cam) p.tx.cam.sender.replaceTrack(t).catch(() => {});
        refreshDevices();
      }
      LS.set("cam", S.state.cam);
      renderLobby(); renderSelf(); sendState(); layout();
    } finally { S.busy.cam = false; }
  }

  // ------------------------------------------------------------- websocket
  function wsUrl() { return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws"; }
  function send(obj) { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(obj)); return true; } return false; }
  function sendState() { send({ type: "state", state: S.state }); }

  function connect() {
    clearTimeout(S.reconnectTimer);
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { onDisconnected(); return; }
    S.ws = ws;
    ws.onopen = () => {
      S.lastRx = Date.now();
      const name = $("name").value.trim() || prefs.name || "Guest";
      ws.send(JSON.stringify({ type: "join", room: code, name, state: S.state, id: S.id || undefined, token: S.token || undefined }));
    };
    ws.onmessage = (e) => { S.lastRx = Date.now(); let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
    ws.onclose = (e) => {
      if (S.ws !== ws) return;
      S.ws = null;
      if (e.code === 4000) { leave("You joined this meeting from another tab or device.", "Disconnected"); return; }
      onDisconnected();
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  function onDisconnected() {
    stopPing();
    if (S.leaving || S.phase === "left") return;
    if (S.phase === "lobby") { if (!S.lobbyErrorShown) lobbyError("Could not reach the meeting server. Try again."); return; }
    S.wsTries++;
    if (S.wsTries === 1) toast("Connection lost. Reconnecting…", "warn", 4000);
    if (S.wsTries > 12) { leave("Lost the connection to the meeting server.", "Connection lost"); return; }
    const delay = Math.min(10000, 800 * Math.pow(1.7, S.wsTries - 1)) * (0.7 + Math.random() * 0.6);   // jitter: no reconnect stampede
    S.reconnectTimer = setTimeout(connect, delay);
  }
  let pingTimer = 0;
  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (S.ws && S.ws.readyState === 1 && Date.now() - S.lastRx > 50000) {   // half-open socket (sleep/wake, NAT drop)
        try { S.ws.close(); } catch (e) { /* onclose reconnects */ }
        return;
      }
      send({ type: "ping", t: Date.now() });
    }, 20000);
  }
  function stopPing() { clearInterval(pingTimer); pingTimer = 0; }

  function lobbyError(text) {
    const h = $("lobby-hint"); h.textContent = text; h.className = "hint error";
    $("join").disabled = false; $("join").textContent = "Join now";
  }

  function onMessage(m) {
    switch (m.type) {
      case "welcome": return onWelcome(m);
      case "error": {
        if (S.phase === "lobby") { S.lobbyErrorShown = true; lobbyError(m.message || m.code); }
        else if (m.code === "slow-down") toast(m.message, "warn");
        else toast(m.message || m.code, "error");
        return;
      }
      case "closed": return leave(m.reason === "server stopped" ? "The host stopped the server." : "The host ended the meeting.", "Meeting ended");
      case "peer-joined": {
        addPeer(m.peer);
        sysMessage(m.peer.name + " joined");
        if (S.peers.size <= 6) sounds.join();
        return;
      }
      case "peer-left": {
        const p = S.peers.get(m.id);
        if (p) { removePeer(m.id); if (m.reason !== "reconnect") { sysMessage(p.name + " left"); if (S.peers.size < 6) sounds.leave(); } }
        return;
      }
      case "signal": {
        const p = S.peers.get(m.from);
        if (p) { p.queue = p.queue.then(() => onSignal(p, m.data)).catch((e) => console.warn("signal", e)); return; }
        const q = S.pendingSignals.get(m.from) || [];            // offer arrived before peer-joined: hold it
        if (q.length < 40) q.push({ data: m.data, at: Date.now() });
        S.pendingSignals.set(m.from, q);
        return;
      }
      case "state": { const p = S.peers.get(m.id); if (p) { const was = p.state; p.state = m.state; onPeerState(p, was); } return; }
      case "want": { const p = S.peers.get(m.from); if (p) { p.wantCam = m.cam !== false; p.wantScreen = m.screen !== false; applyParams(p); } return; }
      case "chat": return addChat(m, true);
      case "rename": { const p = S.peers.get(m.id); if (p) { p.name = m.name; renderTile(p); renderPeople(); } return; }
      case "pong": return;
      default: return;
    }
  }

  function onWelcome(m) {
    const reconnecting = S.phase === "call";
    S.id = m.id; S.token = m.token || S.token; S.room = m.room; S.config = m.config; S.wsTries = 0;
    startPing();
    if (reconnecting) {
      for (const id of [...S.peers.keys()]) removePeer(id, true);
      toast("Reconnected", "", 2000);
    } else {
      enterCall();
    }
    (m.chat || []).forEach((c) => addChat(c, false));          // deduped: safe after a reconnect too
    m.peers.forEach((p) => addPeer(p));
    renderPeople(); layout();
  }

  // ------------------------------------------------------------- call ui
  function enterCall() {
    S.phase = "call"; S.joinedAt = Date.now();
    $("lobby").classList.add("hidden"); $("call").classList.remove("hidden");
    $("room-title").textContent = (S.room && S.room.label) || code;
    document.title = ((S.room && S.room.label) || code) + " · " + ((S.config && S.config.serverName) || "Rooms");
    $("bar-left").textContent = $("name").value.trim();
    ensureAudioCtx();
    setupLocalAnalyser();
    const preview = $("preview-video"); preview.srcObject = null;
    ensureSelfTile(); renderSelf();
    $("btn-share").disabled = !hasDisplay; if (!hasDisplay) $("btn-share").title = "Screen sharing isn't available in this browser";
    setInterval(tickTimer, 1000);
    setInterval(speakingTick, 400);
    setInterval(statsTick, 3000);
    layout();
  }
  function tickTimer() {
    if (!S.joinedAt) return;
    const s = Math.floor((Date.now() - S.joinedAt) / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    $("timer").textContent = (hh ? hh + ":" : "") + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
  }

  function leave(reason, title) {
    if (S.phase === "left") return;
    S.leaving = true; S.phase = "left";
    stopPing(); clearTimeout(S.reconnectTimer);
    send({ type: "leave" });
    try { if (S.ws) S.ws.close(); } catch (e) { /* ignore */ }
    S.ws = null;
    for (const id of [...S.peers.keys()]) removePeer(id, true);
    stopTrack(S.local.mic); stopTrack(S.local.cam); stopTrack(S.local.screen);
    S.local = { mic: null, cam: null, screen: null };
    $("call").classList.add("hidden"); $("lobby").classList.add("hidden"); $("left").classList.remove("hidden");
    $("left-title").textContent = title || "You left the meeting";
    $("left-msg").textContent = reason || "";
    document.title = "Rooms";
  }

  // ------------------------------------------------------------- peers
  function addPeer(info) {
    if (S.peers.has(info.id)) removePeer(info.id, true);
    const peer = {
      id: info.id, name: info.name, state: info.state || { mic: false, cam: false, screen: false, hand: false },
      pc: null, polite: false, makingOffer: false, ignoreOffer: false, queue: Promise.resolve(), pending: [],
      tx: {}, tracks: {}, el: {}, speaking: false, wantCam: true, wantScreen: true, attempts: info.attempts || 0,
      stats: { lastBytes: 0, lastTs: 0, kbps: 0, rtt: 0, loss: 0, w: 0, h: 0, fps: 0 }, iceTimer: 0, watchdog: 0,
    };
    S.peers.set(peer.id, peer);
    makeTile(peer);
    createPC(peer);
    const held = S.pendingSignals.get(peer.id);
    if (held) {
      S.pendingSignals.delete(peer.id);
      held.filter((h) => Date.now() - h.at < 15000).forEach((h) => { peer.queue = peer.queue.then(() => onSignal(peer, h.data)).catch(() => {}); });
    }
    if (peer.state.screen) notePresenter(peer.id, true);
    if (prefs.audioOnly || document.hidden) send({ type: "want", to: peer.id, cam: !prefs.audioOnly && !document.hidden, screen: !document.hidden });
    renderPeople(); updateBadges(); layout();
    for (const p of S.peers.values()) applyParams(p);   // scale down as the call grows
  }
  function removePeer(id, silent) {
    const peer = S.peers.get(id);
    if (!peer) return;
    S.peers.delete(id);
    clearTimeout(peer.iceTimer); clearTimeout(peer.watchdog);
    try { if (peer.pc) peer.pc.close(); } catch (e) { /* ignore */ }
    if (peer.el.audio) { peer.el.audio.srcObject = null; peer.el.audio.remove(); }
    if (peer.el.tile) peer.el.tile.remove();
    notePresenter(id, false);
    if (S.pinned === id) S.pinned = null;
    renderPeople(); updateBadges(); layout();
    for (const p of S.peers.values()) applyParams(p);
  }

  function createPC(peer) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: (S.config && S.config.iceServers) || [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    } catch (e) {
      peer.pc = null;
      if (!S.pcErrorShown) { S.pcErrorShown = true; toast("Could not set up a connection (check the host's TURN settings): " + (e.message || e.name), "error", 9000); }
      renderTile(peer);
      return;
    }
    peer.pc = pc;
    peer.polite = S.id < peer.id;
    const initiator = !peer.polite;            // deterministic: the higher id always offers
    peer.watchdog = setTimeout(() => checkStuck(peer, 1), 12000);
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "signal", to: peer.id, data: { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate } }); };
    pc.onnegotiationneeded = async () => {
      try { peer.makingOffer = true; await pc.setLocalDescription(); send({ type: "signal", to: peer.id, data: { description: pc.localDescription } }); }
      catch (e) { console.warn("negotiation", e); }
      finally { peer.makingOffer = false; }
    };
    pc.ontrack = (e) => {
      const idx = pc.getTransceivers().indexOf(e.transceiver);
      const role = ROLES[idx];
      if (!role) return;
      peer.tracks[role] = e.track;
      attachRemote(peer, role);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") { clearTimeout(peer.iceTimer); clearTimeout(peer.watchdog); peer.attempts = 0; applyParams(peer); }
      if (st === "failed") restartIce(peer);
      renderTile(peer);
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      clearTimeout(peer.iceTimer);
      if (st === "failed") restartIce(peer);
      else if (st === "disconnected") peer.iceTimer = setTimeout(() => { if (pc.iceConnectionState === "disconnected") restartIce(peer); }, 5000);
    };
    if (initiator) {
      peer.tx.mic = pc.addTransceiver("audio", { direction: "sendrecv" });
      peer.tx.cam = pc.addTransceiver("video", { direction: "sendrecv" });
      peer.tx.screen = pc.addTransceiver("video", { direction: "sendrecv" });
      preferCodecs(peer.tx.cam); preferCodecs(peer.tx.screen);
      attachLocal(peer);
    }
  }
  function checkStuck(peer, stage) {
    // Nothing negotiated after 12 s (lost offer, both sides waiting): the offerer nudges,
    // then after 15 more seconds both sides start the connection over, up to 3 times.
    if (S.peers.get(peer.id) !== peer || !peer.pc) return;
    const st = peer.pc.connectionState;
    if (st === "connected" || st === "closed") return;
    const initiator = !peer.polite;
    if (stage === 1) {
      if (initiator) {
        if (peer.pc.signalingState === "have-local-offer" && peer.pc.localDescription) send({ type: "signal", to: peer.id, data: { description: peer.pc.localDescription } });
        else restartIce(peer);
      }
      peer.watchdog = setTimeout(() => checkStuck(peer, 2), 15000);
      return;
    }
    if (!initiator) return;
    if (peer.attempts >= 3) {
      if (!peer.gaveUp) { peer.gaveUp = true; toast("Can't connect to " + peer.name + ". A TURN relay may be needed on this network.", "error", 8000); renderTile(peer); }
      return;
    }
    send({ type: "signal", to: peer.id, data: { reset: true } });
    addPeer({ id: peer.id, name: peer.name, state: peer.state, attempts: peer.attempts + 1 });
  }
  function restartIce(peer) {
    if (!peer.pc || peer.pc.signalingState === "closed") return;
    try { peer.pc.restartIce(); } catch (e) { /* older engine */ }
  }
  function adoptTransceivers(peer) {
    const t = peer.pc.getTransceivers();
    ROLES.forEach((role, i) => { if (t[i]) { peer.tx[role] = t[i]; try { t[i].direction = "sendrecv"; } catch (e) { /* ignore */ } } });
    preferCodecs(peer.tx.cam); preferCodecs(peer.tx.screen);
    attachLocal(peer);
  }
  function attachLocal(peer) {
    const map = { mic: S.local.mic, cam: S.state.cam ? S.local.cam : null, screen: S.state.screen ? S.local.screen : null };
    ROLES.forEach((role) => { const tx = peer.tx[role]; if (tx) tx.sender.replaceTrack(map[role] || null).catch(() => {}); });
  }
  function preferCodecs(tx) {
    if (!prefs.h264 || !tx || typeof tx.setCodecPreferences !== "function" || !window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
    try {
      const caps = RTCRtpReceiver.getCapabilities("video");
      if (!caps || !caps.codecs) return;
      const isH264 = (c) => /h264/i.test(c.mimeType);
      const baseline = caps.codecs.filter((c) => isH264(c) && /42e01f/i.test(c.sdpFmtpLine || "") && /packetization-mode=1/.test(c.sdpFmtpLine || ""));
      const otherH264 = caps.codecs.filter((c) => isH264(c) && !baseline.includes(c));
      const rest = caps.codecs.filter((c) => !isH264(c));
      if (baseline.length + otherH264.length) tx.setCodecPreferences([...baseline, ...otherH264, ...rest]);
    } catch (e) { /* codec preferences are an optimisation only */ }
  }
  function applyParams(peer) {
    if (!peer.pc || peer.pc.connectionState === "closed") return;
    const total = S.peers.size + 1;                       // people in the call, me included
    const scale = total <= 4 ? 1 : total <= 6 ? 1.5 : 2;  // protect CPU as the mesh grows
    const p = preset();
    setParams(peer.tx.cam, { maxBitrate: Math.round(p.bitrate / (scale * scale) * 1.25), maxFramerate: p.fps, scaleResolutionDownBy: scale, active: peer.wantCam }, "balanced");
    setParams(peer.tx.screen, { maxBitrate: SHARE_BITRATE, maxFramerate: shareFps(), scaleResolutionDownBy: 1, active: peer.wantScreen }, "maintain-resolution");
  }
  async function setParams(tx, enc, degradation) {
    if (!tx || !tx.sender) return;
    try {
      const params = tx.sender.getParameters();
      if (!params.encodings || !params.encodings.length) return;    // not negotiated yet (Firefox)
      Object.assign(params.encodings[0], enc);
      params.degradationPreference = degradation;
      await tx.sender.setParameters(params);
    } catch (e) { /* unsupported field on this engine */ }
  }

  async function onSignal(peer, data) {
    if (data.reset) {                                           // the offerer is starting over
      addPeer({ id: peer.id, name: peer.name, state: peer.state, attempts: peer.attempts + 1 });
      return;
    }
    const pc = peer.pc;
    if (!pc || pc.signalingState === "closed") return;
    if (data.description) {
      const d = data.description;
      const collision = d.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === "offer") {
        if (!peer.tx.mic) adoptTransceivers(peer);
        await pc.setLocalDescription();
        send({ type: "signal", to: peer.id, data: { description: pc.localDescription } });
      }
      while (peer.pending.length) { const c = peer.pending.shift(); try { await pc.addIceCandidate(c); } catch (e) { /* stale */ } }
    } else if (data.candidate) {
      if (!pc.remoteDescription) { peer.pending.push(data.candidate); return; }
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) console.warn("candidate", e); }
    }
  }

  // ------------------------------------------------------------- remote media
  function attachRemote(peer, role) {
    const track = peer.tracks[role];
    if (role === "mic") {
      if (!peer.el.audio) { peer.el.audio = document.createElement("audio"); peer.el.audio.autoplay = true; $("audio-sink").appendChild(peer.el.audio); }
      peer.el.audio.srcObject = new MediaStream([track]);
      if (canSink && prefs.spkId) peer.el.audio.setSinkId(prefs.spkId).catch(() => {});
      peer.el.audio.play().catch(() => {});
    } else if (role === "cam") {
      peer.el.video.srcObject = new MediaStream([track]);
      renderTile(peer);
    } else if (role === "screen") {
      layout();
    }
  }
  function onPeerState(peer, was) {
    if (peer.state.screen !== was.screen) {
      notePresenter(peer.id, peer.state.screen);
      if (peer.state.screen) toast(peer.name + " is presenting", "", 2500);
    }
    if (peer.state.hand && !was.hand) toast(peer.name + " raised a hand ✋", "", 4000);
    renderTile(peer); renderPeople(); layout();
  }
  function notePresenter(id, on) {
    S.presenters = S.presenters.filter((x) => x !== id);
    if (on) S.presenters.push(id);
  }

  // ------------------------------------------------------------- tiles & layout
  function makeTile(peer) {
    const tile = el("div", "tile"); tile.dataset.id = peer.id;
    const video = document.createElement("video"); video.autoplay = true; video.playsInline = true; video.muted = peer.id === "self";
    tile.appendChild(video);
    const av = el("div", "avatar", initials(peer.name)); tile.appendChild(av);
    const bottom = el("div", "tile-bottom");
    const name = el("span", "tile-name"); bottom.appendChild(name);
    bottom.insertAdjacentHTML("beforeend", '<svg class="ico tile-mic"><use href="#i-mic-off"/></svg>');
    tile.appendChild(bottom);
    tile.appendChild(el("div", "tile-hand", "✋"));
    const q = el("div", "tile-quality"); tile.appendChild(q);
    const pin = el("button", "tile-pin"); pin.type = "button"; pin.title = "Pin"; pin.innerHTML = '<svg class="ico"><use href="#i-pin"/></svg>'; tile.appendChild(pin);
    tile.addEventListener("click", () => { S.pinned = S.pinned === peer.id ? null : peer.id; layout(); });
    peer.el = Object.assign(peer.el || {}, { tile, video, avatar: av, name, quality: q });
    $("grid").appendChild(tile);
    renderTile(peer);
    return tile;
  }
  const SELF = { id: "self", el: {}, get name() { return $("name").value.trim() || "You"; }, get state() { return S.state; } };
  function ensureSelfTile() {
    if (!SELF.el.tile) { makeTile(SELF); SELF.el.tile.classList.add("mirror"); }
    $("grid").appendChild(SELF.el.tile);          // keep self last
    SELF.el.tile.classList.toggle("hidden", prefs.hideSelf);
  }
  function renderSelf() {
    if (!SELF.el.tile) return;
    const v = SELF.el.video;
    if (S.state.cam && S.local.cam) { if (!v.srcObject || v.srcObject.getVideoTracks()[0] !== S.local.cam) v.srcObject = new MediaStream([S.local.cam]); }
    else v.srcObject = null;
    renderTile(SELF);
    $("btn-mic").setAttribute("aria-pressed", String(S.state.mic));
    $("btn-cam").setAttribute("aria-pressed", String(S.state.cam));
    $("btn-share").classList.toggle("on", S.state.screen);
    $("btn-hand").classList.toggle("on", S.state.hand);
    renderPeople();
  }
  function renderTile(peer) {
    const t = peer.el.tile; if (!t) return;
    const isSelf = peer === SELF;
    const camOn = isSelf ? (S.state.cam && !!S.local.cam) : (peer.state.cam && !!peer.tracks.cam && !prefs.audioOnly);
    t.classList.toggle("cam-off", !camOn);
    t.classList.toggle("mic-off", !peer.state.mic);
    t.classList.toggle("hand", !!peer.state.hand);
    t.classList.toggle("pinned", S.pinned === peer.id);
    peer.el.name.textContent = peer.name + (isSelf ? " (You)" : "");
    peer.el.avatar.textContent = initials(peer.name);
    if (!isSelf && peer.pc) {
      const st = peer.pc.connectionState;
      if (peer.gaveUp) peer.el.name.textContent += " · can't connect";
      else if (st !== "connected" && st !== "connecting" && st !== "new") peer.el.name.textContent += " · " + st;
      else if (st !== "connected") peer.el.name.textContent += " · connecting";
    } else if (!isSelf && !peer.pc) peer.el.name.textContent += " · no connection";
  }
  function stageTarget() {
    if (S.pinned && (S.pinned === "self" || S.peers.has(S.pinned))) return { id: S.pinned, kind: "pin" };
    const presenter = S.presenters[S.presenters.length - 1];
    if (presenter === "self" && S.state.screen) return { id: "self", kind: "screen" };
    if (presenter && S.peers.has(presenter) && S.peers.get(presenter).state.screen) return { id: presenter, kind: "screen" };
    return null;
  }
  let stageVideo = null, stageKey = "";
  function renderStage(target) {
    const stage = $("stage");
    if (!target) { stage.classList.add("hidden"); if (stageVideo) { stageVideo.srcObject = null; } stage.textContent = ""; stageVideo = null; stageKey = ""; return; }
    stage.classList.remove("hidden");
    const peer = target.id === "self" ? SELF : S.peers.get(target.id);
    const showScreen = target.kind === "screen" || (target.kind === "pin" && peer.state.screen && target.id !== "self");
    const key = target.id + ":" + (showScreen ? "screen" : "cam");
    if (key !== stageKey) {
      stage.textContent = ""; stageKey = key; stageVideo = null;
      if (target.id === "self" && showScreen) {
        const card = el("div", "self-share");
        card.appendChild(el("b", null, "You're presenting to everyone"));
        const b = el("button", "secondary", "Stop presenting"); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation(); stopShare(); });
        card.appendChild(b); stage.appendChild(card);
      } else {
        stageVideo = document.createElement("video"); stageVideo.autoplay = true; stageVideo.playsInline = true; stageVideo.muted = true;
        if (target.id === "self") stageVideo.style.transform = "scaleX(-1)";
        stage.appendChild(stageVideo);
      }
      const label = el("div", "stage-label", showScreen ? peer.name + " is presenting" : peer.name);
      stage.appendChild(label);
      if (target.kind === "pin") {
        const un = el("button", "tile-pin"); un.type = "button"; un.title = "Unpin"; un.innerHTML = '<svg class="ico"><use href="#i-pin"/></svg>';
        un.addEventListener("click", () => { S.pinned = null; layout(); }); stage.appendChild(un);
      }
    }
    if (stageVideo) {
      const track = target.id === "self" ? (showScreen ? S.local.screen : S.local.cam) : (showScreen ? peer.tracks.screen : peer.tracks.cam);
      const cur = stageVideo.srcObject && stageVideo.srcObject.getVideoTracks()[0];
      if (track && cur !== track) stageVideo.srcObject = new MediaStream([track]);
      if (!track) stageVideo.srcObject = null;
    }
  }
  function layout() {
    if (S.phase !== "call") return;
    const media = $("media"), grid = $("grid");
    const target = stageTarget();
    media.classList.toggle("staged", !!target);
    document.body.classList.toggle("staged", !!target);
    renderStage(target);
    const tiles = [...grid.children].filter((t) => !t.classList.contains("hidden"));
    const n = tiles.length;
    if (target || !n) return;
    const W = grid.clientWidth, H = grid.clientHeight, gap = 10;
    let best = { w: 160, h: 90 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      let w = Math.floor((W - gap * (cols - 1)) / cols), h = Math.floor((H - gap * (rows - 1)) / rows);
      if (w / h > 16 / 9) w = Math.floor(h * 16 / 9); else h = Math.floor(w * 9 / 16);
      if (w > best.w) best = { w, h };
    }
    grid.style.setProperty("--tw", best.w + "px"); grid.style.setProperty("--th", best.h + "px");
  }

  // ------------------------------------------------------------- screen share
  async function startShare() {
    if (!hasDisplay || S.busy.share || S.phase === "left") return;
    S.busy.share = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: shareFps(), max: shareFps() }, width: { max: 1920 }, height: { max: 1080 } },
        audio: false, selfBrowserSurface: "exclude", surfaceSwitching: "include",
      });
    } catch (e) { S.busy.share = false; if (e.name !== "NotAllowedError") toast("Could not share screen: " + (e.message || e.name), "error"); return; }
    S.busy.share = false;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    if (S.phase === "left" || S.state.screen) { stopTrack(track); return; }   // left, or a second picker finished first
    try { track.contentHint = "detail"; } catch (e) { /* ignore */ }
    stopTrack(S.local.screen);
    S.local.screen = track; S.state.screen = true;
    track.onended = () => { if (S.local.screen === track) stopShare(); };
    for (const p of S.peers.values()) { if (p.tx.screen) p.tx.screen.sender.replaceTrack(track).catch(() => {}); applyParams(p); }
    notePresenter("self", true);
    sendState(); renderSelf(); layout();
  }
  function stopShare() {
    if (!S.state.screen) return;
    const t = S.local.screen; S.local.screen = null; S.state.screen = false; stopTrack(t);
    for (const p of S.peers.values()) if (p.tx.screen) p.tx.screen.sender.replaceTrack(null).catch(() => {});
    notePresenter("self", false);
    sendState(); renderSelf(); layout();
  }

  // ------------------------------------------------------------- speaking & stats
  function ensureAudioCtx() {
    try {
      if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (S.audioCtx.state === "suspended" && S.audioCtx.resume) S.audioCtx.resume().catch(() => {});
    } catch (e) { S.audioCtx = null; }
  }
  function setupLocalAnalyser() {
    if (!S.audioCtx || !S.local.mic || S.analyser) return;
    try {
      const src = S.audioCtx.createMediaStreamSource(new MediaStream([S.local.mic]));
      S.analyser = S.audioCtx.createAnalyser(); S.analyser.fftSize = 256; src.connect(S.analyser);
      S.analyserData = new Uint8Array(S.analyser.fftSize);
    } catch (e) { S.analyser = null; }
  }
  function localLevel() {
    if (!S.analyser) return 0;
    S.analyser.getByteTimeDomainData(S.analyserData);
    let sum = 0; for (let i = 0; i < S.analyserData.length; i += 4) { const v = (S.analyserData[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / (S.analyserData.length / 4));
  }
  function speakingTick() {
    if (S.phase !== "call") return;
    for (const p of S.peers.values()) {
      const rx = p.tx.mic && p.tx.mic.receiver;
      let level = 0;
      if (rx && typeof rx.getSynchronizationSources === "function") {
        const s = rx.getSynchronizationSources();
        if (s.length && typeof s[0].audioLevel === "number") level = s[0].audioLevel;
      }
      const speaking = p.state.mic && level > 0.01;
      if (speaking !== p.speaking) { p.speaking = speaking; p.el.tile.classList.toggle("speaking", speaking); }
    }
    const lvl = localLevel();
    const selfSpeaking = S.state.mic && lvl > 0.02;
    if (SELF.el.tile) SELF.el.tile.classList.toggle("speaking", selfSpeaking);
    if (!S.state.mic && lvl > 0.06 && Date.now() - S.lastMutedHint > 15000) { S.lastMutedHint = Date.now(); toast("Are you talking? Your mic is off (⌘D)", "warn", 3000); }
  }
  async function statsTick() {
    if (S.phase !== "call" || document.hidden) return;
    let worstRtt = 0, worstLoss = 0, any = false;
    for (const p of S.peers.values()) {
      if (!p.pc || p.pc.connectionState !== "connected") continue;
      let report;
      try { report = await p.pc.getStats(); } catch (e) { continue; }
      let rtt = 0, inVideo = null, lost = 0, recv = 0;
      report.forEach((r) => {
        if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded" && typeof r.currentRoundTripTime === "number") rtt = r.currentRoundTripTime;
        if (r.type === "inbound-rtp" && r.kind === "video") {
          const isCam = !p.tracks.cam || !r.trackIdentifier || r.trackIdentifier === p.tracks.cam.id;
          if (isCam && (!inVideo || (r.bytesReceived || 0) > (inVideo.bytesReceived || 0))) inVideo = r;
        }
        if (r.type === "inbound-rtp") { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; }
      });
      const st = p.stats, now = Date.now();
      if (inVideo) {
        if (st.lastTs) st.kbps = Math.round(((inVideo.bytesReceived - st.lastBytes) * 8) / Math.max(1, now - st.lastTs));
        st.lastBytes = inVideo.bytesReceived || 0; st.lastTs = now;
        st.w = inVideo.frameWidth || 0; st.h = inVideo.frameHeight || 0; st.fps = Math.round(inVideo.framesPerSecond || 0);
      }
      st.rtt = rtt; st.loss = recv ? lost / (recv + lost) : 0;
      any = true; worstRtt = Math.max(worstRtt, rtt); worstLoss = Math.max(worstLoss, st.loss);
      if (prefs.stats) p.el.quality.textContent = `${st.w}×${st.h} ${st.fps}fps ${st.kbps}kb/s\nrtt ${Math.round(rtt * 1000)}ms loss ${(st.loss * 100).toFixed(1)}%`;
    }
    const net = $("net");
    const level = !any ? "" : (worstRtt < 0.15 && worstLoss < 0.02) ? "good" : (worstRtt < 0.4 && worstLoss < 0.06) ? "fair" : "poor";
    if (level !== S.netLevel) { S.netLevel = level; net.className = "net " + level; net.textContent = level || (S.peers.size ? "connecting" : "alone"); }
    else if (!any) net.textContent = S.peers.size ? "connecting" : "alone";
  }

  // ------------------------------------------------------------- chat & people
  function addChat(m, live) {
    const dk = m.id + "|" + m.ts + "|" + m.text;
    if (S.seenChat.has(dk)) return;
    S.seenChat.add(dk);
    if (S.seenChat.size > 400) S.seenChat = new Set([...S.seenChat].slice(-200));
    const list = $("chat-list"); $("chat-empty").classList.add("hidden");
    const mine = m.id === S.id;
    const key = m.id + ":" + m.name;
    const grouped = key === S.lastChatKey && m.ts - S.lastChatTs < 120000 && list.lastElementChild && !list.lastElementChild.classList.contains("sys");
    let wrap = grouped ? list.lastElementChild : null;
    if (!wrap) {
      wrap = el("div", "msg" + (mine ? " me" : ""));
      const head = el("div", "msg-head"); head.appendChild(el("b", null, mine ? "You" : m.name));
      const t = el("time", null, fmtTime(m.ts)); head.appendChild(t); wrap.appendChild(head); list.appendChild(wrap);
    }
    const body = el("div", "msg-body"); linkify(body, m.text); wrap.appendChild(body);
    S.lastChatKey = key; S.lastChatTs = m.ts;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (nearBottom || mine) list.scrollTop = list.scrollHeight;
    if (live && !mine && !(S.panelOpen && S.panelTab === "chat" && !document.hidden)) { S.unread++; updateBadges(); sounds.chat(); }
  }
  function sysMessage(text) {
    const list = $("chat-list"); const n = el("div", "msg sys", text + " · " + fmtTime(Date.now())); list.appendChild(n);
    S.lastChatKey = ""; list.scrollTop = list.scrollHeight;
  }
  function linkify(node, text) {
    const re = /(https?:\/\/[^\s<>"']+)/g; let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = el("a", null, m[1]); a.href = m[1]; a.target = "_blank"; a.rel = "noopener noreferrer"; node.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }
  function updateBadges() {
    $("chat-badge").textContent = S.unread ? String(S.unread) : "";
    $("people-badge").textContent = String(S.peers.size + 1);
    $("people-count").textContent = String(S.peers.size + 1);
    const base = ((S.room && S.room.label) || code) + " · " + ((S.config && S.config.serverName) || "Rooms");
    document.title = (S.unread ? "(" + S.unread + ") " : "") + base;
  }
  function renderPeople() {
    const ul = $("people"); if (!ul) return;
    ul.textContent = "";
    const row = (name, state, isSelf) => {
      const li = el("li"); li.appendChild(el("div", "avatar", initials(name)));
      const n = el("span", "pname", name); if (isSelf) { const s = el("small", null, "You"); n.appendChild(s); } li.appendChild(n);
      const st = el("span", "pstate");
      if (state.hand) st.appendChild(el("span", null, "✋"));
      st.insertAdjacentHTML("beforeend", `<svg class="ico ${state.mic ? "" : "off"}"><use href="#${state.mic ? "i-mic" : "i-mic-off"}"/></svg><svg class="ico ${state.cam ? "" : "off"}"><use href="#${state.cam ? "i-cam" : "i-cam-off"}"/></svg>`);
      if (state.screen) st.insertAdjacentHTML("beforeend", '<svg class="ico on"><use href="#i-screen"/></svg>');
      li.appendChild(st); ul.appendChild(li);
    };
    row(SELF.name, S.state, true);
    [...S.peers.values()].forEach((p) => row(p.name, p.state, false));
  }
  function openPanel(tab) {
    S.panelOpen = true; S.panelTab = tab;
    $("panel").classList.remove("hidden");
    document.querySelectorAll(".panel-tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("tab-chat").classList.toggle("hidden", tab !== "chat"); $("tab-people").classList.toggle("hidden", tab !== "people");
    $("btn-chat").classList.toggle("on", tab === "chat"); $("btn-people").classList.toggle("on", tab === "people");
    if (tab === "chat") { S.unread = 0; updateBadges(); const l = $("chat-list"); l.scrollTop = l.scrollHeight; setTimeout(() => $("chat-input").focus(), 50); }
    layout();
  }
  function closePanel() { S.panelOpen = false; $("panel").classList.add("hidden"); $("btn-chat").classList.remove("on"); $("btn-people").classList.remove("on"); layout(); }
  function togglePanel(tab) { if (S.panelOpen && S.panelTab === tab) closePanel(); else openPanel(tab); }

  // ------------------------------------------------------------- settings
  function openSettings() {
    fillDeviceSelects();
    $("set-quality").value = prefs.camera; $("set-sharefps").value = String(prefs.shareFps || 0);
    $("set-audioonly").checked = prefs.audioOnly; $("set-h264").checked = prefs.h264; $("set-hideself").checked = prefs.hideSelf;
    $("set-sounds").checked = prefs.sounds; $("set-stats").checked = prefs.stats;
    $("settings").showModal();
  }
  async function switchMic(id) {
    prefs.micId = id; LS.set("micId", id);
    try {
      const t = await getMic(id);
      if (S.phase === "left") { stopTrack(t); return; }
      t.enabled = S.state.mic; watchTrack(t, "mic");
      const old = S.local.mic; S.local.mic = t; stopTrack(old);
      for (const p of S.peers.values()) if (p.tx.mic) p.tx.mic.sender.replaceTrack(t).catch(() => {});
      if (S.analyser) { S.analyser = null; setupLocalAnalyser(); }
    } catch (e) { toast(permissionHint(e), "error"); }
  }
  async function switchCam(id) {
    prefs.camId = id; LS.set("camId", id);
    if (!S.state.cam) return;
    try {
      const t = await getCam(id);
      if (S.phase === "left" || !S.state.cam) { stopTrack(t); return; }    // toggled off while the picker was open
      watchTrack(t, "cam");
      const old = S.local.cam; S.local.cam = t; stopTrack(old);
      for (const p of S.peers.values()) if (p.tx.cam) p.tx.cam.sender.replaceTrack(t).catch(() => {});
      renderLobby(); renderSelf(); layout();
    } catch (e) { toast(permissionHint(e), "error"); }
  }
  function switchSpk(id) {
    prefs.spkId = id; LS.set("spkId", id);
    if (!canSink) return;
    for (const p of S.peers.values()) if (p.el.audio) p.el.audio.setSinkId(id || "").catch(() => {});
  }
  async function applyCameraPreset() {
    if (S.local.cam) { const p = preset(); try { await S.local.cam.applyConstraints({ width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps, max: p.fps } }); } catch (e) { /* keep current */ } }
    for (const p of S.peers.values()) applyParams(p);
  }
  function sendWants() {
    const cam = !prefs.audioOnly && !document.hidden, screen = !document.hidden;
    for (const p of S.peers.values()) send({ type: "want", to: p.id, cam, screen });
  }

  // ------------------------------------------------------------- wiring
  function wire() {
    $("name").value = prefs.name;
    $("name").addEventListener("input", () => { $("preview-avatar").textContent = initials($("name").value); });
    $("lobby-mic").addEventListener("click", toggleMic);
    $("lobby-cam").addEventListener("click", toggleCam);
    $("sel-mic").addEventListener("change", (e) => switchMic(e.target.value));
    $("sel-cam").addEventListener("change", (e) => switchCam(e.target.value));
    $("sel-spk").addEventListener("change", (e) => switchSpk(e.target.value));
    $("set-mic").addEventListener("change", (e) => switchMic(e.target.value));
    $("set-cam").addEventListener("change", (e) => switchCam(e.target.value));
    $("set-spk").addEventListener("change", (e) => switchSpk(e.target.value));
    $("lobby-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("name").value.trim();
      if (!name) { $("name").focus(); return; }
      prefs.name = name; LS.set("name", name);
      $("join").disabled = true; $("join").textContent = "Joining…"; $("lobby-hint").textContent = ""; $("lobby-hint").className = "hint";
      S.wsTries = 0; S.lobbyErrorShown = false;
      ensureAudioCtx();                                   // inside the click: Safari needs a gesture
      connect();
    });
    $("btn-mic").addEventListener("click", toggleMic);
    $("btn-cam").addEventListener("click", toggleCam);
    $("btn-share").addEventListener("click", () => (S.state.screen ? stopShare() : startShare()));
    $("btn-hand").addEventListener("click", () => { S.state.hand = !S.state.hand; sendState(); renderSelf(); });
    $("btn-more").addEventListener("click", openSettings);
    $("btn-leave").addEventListener("click", () => leave(""));
    $("btn-chat").addEventListener("click", () => togglePanel("chat"));
    $("btn-people").addEventListener("click", () => togglePanel("people"));
    $("panel-close").addEventListener("click", closePanel);
    document.querySelectorAll(".panel-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.tab)));
    $("chat-form").addEventListener("submit", (e) => {
      e.preventDefault(); const inp = $("chat-input"); const text = inp.value.trim();
      if (!text) return;
      if (!send({ type: "chat", text })) { toast("Not connected right now. Try again in a moment.", "warn"); return; }
      inp.value = "";
    });
    $("copy-link").addEventListener("click", async () => { toast((await copyText(inviteUrl())) ? "Meeting link copied" : inviteUrl()); });
    $("rejoin").addEventListener("click", () => location.reload());
    $("settings-close").addEventListener("click", () => $("settings").close());
    $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").close(); });
    $("set-quality").addEventListener("change", (e) => { prefs.camera = e.target.value; LS.set("camera", prefs.camera); applyCameraPreset(); });
    $("set-sharefps").addEventListener("change", (e) => { prefs.shareFps = Number(e.target.value); LS.set("shareFps", prefs.shareFps); for (const p of S.peers.values()) applyParams(p); if (S.local.screen) S.local.screen.applyConstraints({ frameRate: { ideal: shareFps(), max: shareFps() } }).catch(() => {}); });
    $("set-audioonly").addEventListener("change", (e) => { prefs.audioOnly = e.target.checked; sendWants(); for (const p of S.peers.values()) renderTile(p); layout(); });
    $("set-h264").addEventListener("change", (e) => { prefs.h264 = e.target.checked; LS.set("h264", prefs.h264); });
    $("set-hideself").addEventListener("change", (e) => { prefs.hideSelf = e.target.checked; LS.set("hideSelf", prefs.hideSelf); ensureSelfTile(); layout(); });
    $("set-sounds").addEventListener("change", (e) => { prefs.sounds = e.target.checked; LS.set("sounds", prefs.sounds); });
    $("set-stats").addEventListener("change", (e) => { prefs.stats = e.target.checked; $("call").classList.toggle("show-stats", prefs.stats); if (!prefs.stats) for (const p of S.peers.values()) p.el.quality.textContent = ""; });
    document.addEventListener("keydown", (e) => {
      if (S.phase === "left") return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "d") { e.preventDefault(); toggleMic(); }
        else if (k === "e") { e.preventDefault(); toggleCam(); }
      } else if (e.key === "Escape" && S.phase === "call" && S.panelOpen && !$("settings").open) closePanel();
    });
    document.addEventListener("visibilitychange", () => { if (S.phase === "call") sendWants(); });
    document.addEventListener("click", () => {
      if (S.audioCtx && S.audioCtx.state === "suspended") ensureAudioCtx();
      for (const p of S.peers.values()) if (p.el.audio && p.el.audio.paused && p.el.audio.srcObject) p.el.audio.play().catch(() => {});   // Safari: autoplay refused until a gesture
    }, true);
    window.addEventListener("pagehide", () => { if (S.phase === "call") { send({ type: "leave" }); } });
    window.addEventListener("resize", layout);
    if (window.ResizeObserver) new ResizeObserver(() => layout()).observe($("media"));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
  }

  async function lobbyMeta() {
    const meta = $("lobby-meta");
    try {
      const [cfg, info] = await Promise.all([fetch("/api/config").then((r) => r.json()), fetch("/api/rooms/" + encodeURIComponent(code)).then((r) => r.json())]);
      S.config = cfg;
      document.title = code + " · " + (cfg.serverName || "Rooms");
      if (!info.exists && !info.canCreate) {
        meta.textContent = "No meeting with this code."; $("lobby-title").textContent = "Meeting not found";
        S.roomMissing = true; $("join").disabled = true; $("join").textContent = "Join now"; return;
      }
      const label = info.label ? info.label + " · " : "";
      meta.textContent = label + code + " · " + (info.count ? (info.count === 1 ? "1 person is here" : info.count + " people are here") : "No one else is here yet");
    } catch (e) { meta.textContent = code; }
  }

  function init() {
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(code)) { $("lobby-meta").textContent = "That meeting code is not valid."; $("join").disabled = true; return; }
    wire();
    lobbyMeta();
    $("join").disabled = true; $("join").textContent = "Preparing…";
    let readied = false;
    const ready = () => { if (readied || S.roomMissing || S.phase !== "lobby") return; readied = true; $("join").disabled = false; $("join").textContent = "Join now"; };
    startPreview().then(ready, ready);
    setTimeout(ready, 8000);                 // a hung permission prompt must not block joining audio-less
  }
  window.__roomsDebug = S;
  init();
})();
