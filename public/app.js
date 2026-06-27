// app.js — Unwritten client. Dumb renderer: sends player input, renders state.
const PRESETS = [
  "High fantasy: a kingdom on the brink of a magical cataclysm",
  "Cyberpunk: a rain-soaked megacity ruled by corporations",
  "Edo Japan: a province simmering with intrigue and wandering ronin",
  "Space frontier: a struggling colony on a hostile moon",
  "Noir city: a corrupt 1940s metropolis thick with secrets",
];

const state = {
  worldId: null,
  world: null,
  storyId: null,
  selectedPreset: null,
  selectedRole: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.retryable = !!data.retryable;
    err.reason = data.reason;
    throw err;
  }
  return data;
}

const portraitURL = (charId) => `/api/story/${state.storyId}/portrait/${charId}`;
const sceneURL = (turnIndex) => `/api/story/${state.storyId}/scene/${turnIndex}`;
const chapterImgURL = (n) => `/api/story/${state.storyId}/image/${n}`;

// Poll an image's status endpoint while it generates, then swap in the real
// image when ready (v0.3 §4.5). Stops on ready / failed / absent (no provider).
const IMAGE_POLL_BASE = 3000;
function watchImage(imgEl, baseUrl, statusUrl) {
  let delay = IMAGE_POLL_BASE;
  let first = true;
  async function check() {
    if (!imgEl.isConnected) return;
    try {
      const r = await fetch(statusUrl);
      const { status } = await r.json();
      const wasFirst = first;
      first = false;
      if (status === "ready") {
        imgEl.classList.remove("img-generating");
        if (!wasFirst) imgEl.src = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
        return;
      }
      if (status === "failed") {
        imgEl.classList.remove("img-generating");
        imgEl.classList.add("img-unavailable");
        imgEl.title = "Illustration unavailable";
        return;
      }
      if (status === "absent") {
        imgEl.classList.remove("img-generating");
        return; // no provider configured — static placeholder, nothing to wait for
      }
      imgEl.classList.add("img-generating"); // pending | rendering
      imgEl.title = "Illustration generating…";
      delay = Math.min(delay * 1.7, 30000);
      setTimeout(check, delay);
    } catch {
      setTimeout(check, 8000);
    }
  }
  check();
}

// ============ LIGHTBOX (v0.2 §5) ============
const Lightbox = {
  group: [],
  idx: 0,
  open(items, idx = 0) {
    this.group = items;
    this.idx = idx;
    this.render();
    $("#lightbox").classList.remove("hidden");
    this._prevFocus = document.activeElement;
    $("#lb-close").focus();
    document.addEventListener("keydown", this._onKey);
  },
  close() {
    $("#lightbox").classList.add("hidden");
    document.removeEventListener("keydown", this._onKey);
    this._prevFocus?.focus?.();
  },
  render() {
    const it = this.group[this.idx];
    if (!it) return;
    $("#lb-img").src = it.src;
    $("#lb-img").alt = it.caption || "";
    $("#lb-caption").textContent = it.caption || "";
    const multi = this.group.length > 1;
    $("#lb-prev").style.display = multi ? "" : "none";
    $("#lb-next").style.display = multi ? "" : "none";
  },
  prev() {
    this.idx = (this.idx - 1 + this.group.length) % this.group.length;
    this.render();
  },
  next() {
    this.idx = (this.idx + 1) % this.group.length;
    this.render();
  },
  _onKey(e) {
    if (e.key === "Escape") Lightbox.close();
    else if (e.key === "ArrowLeft") Lightbox.prev();
    else if (e.key === "ArrowRight") Lightbox.next();
  },
};

function setupLightbox() {
  $("#lb-close").onclick = () => Lightbox.close();
  $("#lb-prev").onclick = () => Lightbox.prev();
  $("#lb-next").onclick = () => Lightbox.next();
  $("#lightbox").onclick = (e) => {
    if (e.target.id === "lightbox") Lightbox.close();
  };
}

// Compare two image URLs by path, tolerating relative vs. browser-resolved
// absolute forms (the F1 bug: group held relative srcs, img.src was absolute).
function sameImageUrl(a, b) {
  try {
    return new URL(a, location.href).pathname === new URL(b, location.href).pathname;
  } catch {
    return a === b;
  }
}

// Make an <img> open in the lightbox on click (single image or a group).
// `index` (optional) is the known position within `group` — preferred over the
// fragile findIndex lookup.
function zoomable(imgEl, src, caption, group, index) {
  imgEl.style.cursor = "zoom-in";
  imgEl.onclick = () => {
    if (group && group.length) {
      let idx = typeof index === "number" ? index : group.findIndex((g) => sameImageUrl(g.src, src));
      if (idx < 0) idx = 0;
      Lightbox.open(group, idx);
    } else {
      Lightbox.open([{ src, caption }], 0);
    }
  };
}

// ============ ONBOARDING ============
function initOnboarding() {
  const presetsEl = $("#presets");
  PRESETS.forEach((p) => {
    const chip = el("div", "chip", esc(p.split(":")[0]));
    chip.title = p;
    chip.onclick = () => {
      document.querySelectorAll("#presets .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      state.selectedPreset = p;
      $("#world-input").value = p;
    };
    presetsEl.appendChild(chip);
  });

  $("#create-world-btn").onclick = createWorld;
  $("#world-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createWorld();
  });
  $("#start-story-btn").onclick = startStory;
  $("#role-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") startStory();
  });
  $("#back-to-world").onclick = () => {
    $("#step-role").classList.add("hidden");
    $("#step-world").classList.remove("hidden");
  };

  loadExistingWorlds();
  loadStories();
}

async function loadExistingWorlds() {
  try {
    const { worlds } = await api("GET", "/api/worlds");
    const box = $("#existing-worlds");
    box.innerHTML = "";
    if (!worlds.length) return;
    box.appendChild(el("div", "hint", "Worlds you've already built:"));
    worlds.forEach((w) => {
      const row = el("div", "world-row");
      row.innerHTML = `<span><b>${esc(w.title)}</b> <span class="meta">${esc(w.genre)}</span></span><span class="meta">use →</span>`;
      row.onclick = () => selectWorld(w.worldId);
      box.appendChild(row);
    });
  } catch (e) {
    /* no worlds yet */
  }
}

async function loadStories() {
  try {
    const { stories } = await api("GET", "/api/stories");
    if (!stories.length) return;
    const section = $("#resume-section");
    section.classList.remove("hidden");
    const list = $("#story-list");
    list.innerHTML = "";
    stories.forEach((s) => {
      const row = el("div", "story-row");
      row.innerHTML = `<span><b>${esc(s.title)}</b></span><span class="meta">Ch.${s.chapter} · ${s.turnCount} turns · resume →</span>`;
      row.onclick = () => resumeStory(s.storyId);
      list.appendChild(row);
    });
  } catch (e) {
    /* none */
  }
}

async function createWorld() {
  const premise = $("#world-input").value.trim() || state.selectedPreset;
  if (!premise) return setStatus("#world-status", "Pick a preset or describe a world.", true);
  setStatus("#world-status", "Conjuring a world… (this takes a few seconds)");
  $("#create-world-btn").disabled = true;
  try {
    const world = await api("POST", "/api/world", { premise });
    state.worldId = world.worldId;
    state.world = world;
    setStatus("#world-status", "");
    showRoleStep(world);
  } catch (e) {
    setStatus("#world-status", e.message, true);
  } finally {
    $("#create-world-btn").disabled = false;
  }
}

async function selectWorld(worldId) {
  setStatus("#world-status", "Loading world…");
  try {
    const world = await api("GET", `/api/world/${worldId}`);
    state.worldId = world.worldId;
    state.world = world;
    setStatus("#world-status", "");
    showRoleStep(world);
  } catch (e) {
    setStatus("#world-status", e.message, true);
  }
}

function showRoleStep(world) {
  $("#step-world").classList.add("hidden");
  $("#step-role").classList.remove("hidden");
  $("#world-summary").innerHTML = `
    <div class="wtitle">${esc(world.title)}</div>
    <div class="wmeta">${esc(world.genre)} · ${esc(world.tone)}</div>
    <div class="wbible">${esc(world.premise)}</div>`;
  const sug = $("#role-suggestions");
  sug.innerHTML = "";
  (world.roleSuggestions || []).forEach((r) => {
    const chip = el("div", "chip", esc(r));
    chip.onclick = () => {
      document.querySelectorAll("#role-suggestions .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      state.selectedRole = r;
      $("#role-input").value = r;
    };
    sug.appendChild(chip);
  });
}

async function startStory() {
  const role = $("#role-input").value.trim() || state.selectedRole;
  const playerName = $("#name-input").value.trim();
  if (!role) return setStatus("#role-status", "Choose or describe a role.", true);
  setStatus("#role-status", "Opening your story…");
  $("#start-story-btn").disabled = true;
  try {
    const data = await api("POST", "/api/story", { worldId: state.worldId, role, playerName });
    state.storyId = data.storyId;
    enterGame();
    renderState(data.state);
    renderWorld(state.world);
    clearFeed();
    addWorldCard(state.world);
    addGMMessage(data.opening);
    setSuggestions(data.opening.suggestedActions);
  } catch (e) {
    setStatus("#role-status", e.message, true);
  } finally {
    $("#start-story-btn").disabled = false;
  }
}

async function resumeStory(storyId) {
  try {
    const data = await api("GET", `/api/story/${storyId}`);
    state.storyId = storyId;
    state.world = data.world || null;
    enterGame();
    renderState(data.state);
    renderWorld(data.world);
    clearFeed();
    if (data.storySoFar) {
      const recap = el("div", "chapter-card");
      recap.innerHTML = `<div class="cc-body"><div class="cc-title">The story so far</div><div class="cc-recap">${esc(data.storySoFar).replace(/\n/g, "<br>")}</div></div>`;
      $("#feed").appendChild(recap);
    }
    (data.recentTurns || []).forEach((t) => {
      if (t.playerInput) addPlayerMessage(t.playerInput);
      addGMMessage(t);
      if (t.sceneImage) addSceneImage(t.index, t.sceneImage);
    });
    const last = (data.recentTurns || []).slice(-1)[0];
    if (last) setSuggestions(last.suggestedActions);
    loadGallery();
    scrollFeed();
  } catch (e) {
    alert(e.message);
  }
}

function setStatus(sel, msg, isError) {
  const e = $(sel);
  e.textContent = msg;
  e.classList.toggle("error", !!isError);
}

// ============ GAME ============
function enterGame() {
  $("#onboarding").classList.add("hidden");
  $("#game").classList.remove("hidden");
  $("#send-btn").onclick = sendTurn;
  const input = $("#player-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendTurn();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  $("#export-btn").onclick = exportEbook;
  $("#exit-btn").onclick = () => location.reload();
  document.querySelectorAll(".toggle").forEach((t) => {
    t.onclick = () => {
      const body = document.getElementById(t.dataset.target);
      body.classList.toggle("hidden");
    };
  });
  loadGallery();
}

const MAX_AUTO_CONTINUE = 2; // cap consecutive GM auto-continues (avoid runaway)
let autoContinueCount = 0;

function sendTurn() {
  const input = $("#player-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  autoContinueCount = 0; // a real player action resets the auto-continue budget
  return performTurn(text, false);
}

// Run a turn. `auto` = the GM is continuing its own uninterrupted beat
// (needsPlayerInput was false): no player bubble, and a synthetic prompt.
async function performTurn(text, auto) {
  if (!auto) addPlayerMessage(text);
  setSuggestions([]);
  const typing = showTyping();
  $("#send-btn").disabled = true;
  try {
    const result = await api("POST", `/api/story/${state.storyId}/turn`, { input: text });
    typing.remove();
    if (result.diceResult) addDiceCard(result.diceResult);
    addGMMessage(result);
    if (result.sceneImage) addSceneImage(result.state.turnCount, result.sceneImage);
    setSuggestions(result.suggestedActions);
    renderState(result.state);
    if (result.chapterComplete) {
      addChapterCard(result.chapterComplete);
      loadGallery();
    }
    // GM signalled it wants to continue narrating — auto-advance, capped.
    if (result.needsPlayerInput === false && autoContinueCount < MAX_AUTO_CONTINUE) {
      autoContinueCount++;
      setTimeout(() => performTurn("Continue.", true), 500);
    } else {
      autoContinueCount = 0;
    }
  } catch (e) {
    typing.remove();
    if (e.retryable) {
      // API was rate-limited / out of credit beyond the backoff budget (§11).
      addRetryCard(e, text, auto);
    } else {
      const err = el("div", "msg gm");
      err.innerHTML = `<div class="narration" style="border-color:var(--bad)">⚠ ${esc(e.message)}</div>`;
      $("#feed").appendChild(err);
    }
  } finally {
    $("#send-btn").disabled = false;
    scrollFeed();
  }
}

function addRetryCard(e, text, auto) {
  const reason =
    e.reason === "credit"
      ? "The API is out of credit."
      : "The API is busy (rate limit).";
  const card = el("div", "retry-card");
  card.innerHTML = `<div>⏳ ${esc(reason)} Your turn was not lost.</div>`;
  const btn = el("button", "primary", "Retry this turn");
  btn.onclick = () => {
    card.remove();
    performTurn(text, auto);
  };
  card.appendChild(btn);
  $("#feed").appendChild(card);
  scrollFeed();
}

// Inline scene/action image beneath a turn's narration (v0.2 §9).
function addSceneImage(turnIndex, sceneImage) {
  const wrap = el("div", "scene-img-wrap");
  const isAction = sceneImage.kind === "action";
  const cap = isAction ? "Action" : "Scene";
  wrap.innerHTML = `${isAction ? '<span class="badge">⚔ Action</span>' : ""}<img alt="${esc(cap)}" />`;
  const img = wrap.querySelector("img");
  img.src = sceneURL(turnIndex);
  zoomable(img, sceneURL(turnIndex), sceneImage.prompt || cap);
  watchImage(img, sceneURL(turnIndex), `${sceneURL(turnIndex)}/status`);
  $("#feed").appendChild(wrap);
  scrollFeed();
}

// ---- feed rendering ----
function clearFeed() { $("#feed").innerHTML = ""; }
function addPlayerMessage(text) {
  const m = el("div", "msg player", esc(text));
  $("#feed").appendChild(m);
  scrollFeed();
}
function addGMMessage(turn) {
  const m = el("div", "msg gm");
  m.innerHTML = `<div class="narration">${esc(turn.narration)}</div>${
    turn.ask ? `<div class="ask">${esc(turn.ask)}</div>` : ""
  }`;
  $("#feed").appendChild(m);
  scrollFeed();
}
function addDiceCard(d) {
  const cls = {
    "critical success": "crit-success",
    success: "success",
    "partial success": "partial",
    failure: "failure",
    "critical failure": "crit-failure",
  }[d.outcome] || "";
  const card = el("div", "dice-card");
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  card.innerHTML = `
    <div class="dice-head">🎲 ${esc(d.stat)} check · DC ${d.dc}</div>
    <div class="dice-math">d20 ${d.d20} ${sign(d.statMod)} stat ${sign(d.mentalMod)} mind${
      d.situationalModifier ? " " + sign(d.situationalModifier) + " situ" : ""
    } = <b>${d.total}</b></div>
    <div class="outcome ${cls}">${esc(d.outcome)}</div>`;
  $("#feed").appendChild(card);
  scrollFeed();
}
function addChapterCard(ch) {
  const card = el("div", "chapter-card");
  card.innerHTML = `
    <img src="${chapterImgURL(ch.index)}" alt="Chapter ${ch.index}" />
    <div class="cc-body">
      <div class="cc-title">Chapter ${ch.index} — ${esc(ch.title)}</div>
      <div class="cc-recap">${esc(ch.recap)}</div>
      ${ch.turningPoint ? `<div class="cc-turn">Turning point: ${esc(ch.turningPoint)}</div>` : ""}
    </div>`;
  const img = card.querySelector("img");
  zoomable(img, chapterImgURL(ch.index), `Chapter ${ch.index} — ${ch.title}`);
  watchImage(img, chapterImgURL(ch.index), `${chapterImgURL(ch.index)}/status`);
  $("#feed").appendChild(card);
  scrollFeed();
}
function showTyping() {
  const t = el("div", "msg gm");
  t.innerHTML = `<div class="narration" style="padding:0"><div class="typing"><span></span><span></span><span></span></div></div>`;
  $("#feed").appendChild(t);
  scrollFeed();
  // If the turn takes unusually long, the server is likely backing off on a
  // rate limit / credit wait — switch to a waiting indicator (§11.3).
  const timer = setTimeout(() => {
    if (!t.isConnected) return;
    t.innerHTML = `<div class="narration" style="padding:0"><div class="waiting"><span class="spinner"></span> Waiting for API capacity — retrying…</div></div>`;
  }, 14000);
  const origRemove = t.remove.bind(t);
  t.remove = () => {
    clearTimeout(timer);
    origRemove();
  };
  return t;
}
function scrollFeed() {
  const f = $("#feed");
  f.scrollTop = f.scrollHeight;
}

function setSuggestions(actions) {
  const box = $("#suggestions");
  box.innerHTML = "";
  (actions || []).forEach((a) => {
    const s = el("div", "suggestion", esc(a));
    s.onclick = () => {
      $("#player-input").value = a;
      sendTurn();
    };
    box.appendChild(s);
  });
}

// ---- panels ----
function portraitImg(charId, name, cls) {
  return `<img class="portrait ${cls || ""}" data-char="${esc(charId)}" data-name="${esc(name)}" src="${portraitURL(charId)}" alt="${esc(name)}" />`;
}
function wirePortraits(container) {
  container.querySelectorAll("img.portrait[data-char]").forEach((img) => {
    const cid = img.dataset.char;
    zoomable(img, portraitURL(cid), `${img.dataset.name} — portrait`);
    watchImage(img, portraitURL(cid), `${portraitURL(cid)}/status`);
  });
}

let lastState = null;
function renderState(s) {
  if (!s) return;
  lastState = s;
  $("#story-title").textContent = s.title || "";
  $("#scene-line").textContent = `${s.scene.location} · ${s.scene.timeOfDay}`;
  const present = (s.npcsInScene || []).map((n) => n.name);
  $("#present-line").textContent = present.length ? `Present: ${present.join(", ")}` : "";
  $("#chapter-badge").textContent = `Chapter ${s.chapter.index} · beat ${s.chapter.beatCount}/${s.chapter.targetBeats}`;

  renderCharSheet(s.player);
  renderMental(s.player, s.npcsInScene);
  renderGoals(s.goals);
  renderInventory(s.inventory);
  renderRelationships(s.npcs);
  renderEncounter(s.encounter);
  renderActivity(s.activity);

  wirePortraits($("#char-sheet"));
  wirePortraits($("#mental-status"));
  wirePortraits($("#relationships"));
}

// Render a structured profile (v0.3 §5.7) as compact rows.
function profileHTML(profile) {
  if (!profile || !Object.keys(profile).length) return "";
  const rows = [];
  const row = (label, val) => rows.push(`<div class="prof-row"><span class="prof-k">${label}</span><span class="prof-v">${val}</span></div>`);
  const fac = profile.faction;
  const facStr = fac?.name
    ? `${esc(fac.name)}${fac.rank ? ` <span class="meta">(${esc(fac.rank)}${fac.standing ? `, ${esc(fac.standing)}` : ""})</span>` : ""}`
    : "";
  if (profile.occupation) row("Occupation", esc(profile.occupation));
  if (facStr) row("Faction", facStr);
  if (profile.personality?.length) row("Personality", esc(profile.personality.join(", ")));
  if (profile.powers?.length)
    row("Powers", profile.powers.map((p) => `${esc(p.name)} <span class="meta">(${esc(p.stat || "?")})</span>`).join(", "));
  if (profile.weapons?.length) row("Weapons", esc(profile.weapons.map((w) => w.name).join(", ")));
  if (profile.gear?.length) row("Gear", esc(profile.gear.map((g) => g.name).join(", ")));
  if (profile.motivations?.length) row("Motives", esc(profile.motivations.join("; ")));
  if (profile.background) row("Background", esc(profile.background));
  return rows.length ? `<div class="profile">${rows.join("")}</div>` : "";
}

function renderCharSheet(p) {
  const box = $("#char-sheet");
  if (!p) return (box.innerHTML = "");
  const stats = Object.entries(p.stats || {})
    .map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><span class="v">${v}</span></div>`)
    .join("");
  const canon = (p.canon || []).length
    ? `<div class="canon"><div class="canon-h">Established</div>${p.canon
        .map((c) => `<div class="canon-fact">${esc(c)}</div>`)
        .join("")}</div>`
    : "";
  box.innerHTML = `<div class="char-head">${portraitImg(p.id, p.name)}<div class="meta"><div class="char-name">${esc(p.name)}</div><div class="char-role">${esc(p.role)}</div></div></div><div class="stat-grid">${stats}</div>${profileHTML(p.profile)}${canon}`;
}

function mentalBlock(c) {
  const ms = c.mentalStatus || {};
  const d = ms.dimensions || {};
  const bar = (label, key, cls) => {
    const v = d[key] ?? 0;
    return `<div class="bar-row"><span class="label">${label}</span><div class="bar ${cls}"><span style="width:${v}%"></span></div><span class="num">${v}</span></div>`;
  };
  return `<div class="mental-block">
    <div class="who"><span class="who-left">${portraitImg(c.id, c.name, "sm")}<span class="name">${esc(c.name)}</span></span><span class="state">${esc(ms.state || "—")}</span></div>
    ${bar("Stress", "Stress", "stress")}
    ${bar("Morale", "Morale", "morale")}
    ${bar("Trust", "Trust", "trust")}
    ${bar("Composure", "Composure", "composure")}
  </div>`;
}
function renderMental(player, npcsInScene) {
  let html = player ? mentalBlock(player) : "";
  (npcsInScene || []).forEach((n) => (html += mentalBlock(n)));
  $("#mental-status").innerHTML = html || `<div class="empty">—</div>`;
}

function renderGoals(goals) {
  const active = (goals || []).filter((g) => g.status !== "abandoned");
  $("#goals").innerHTML =
    active.length
      ? active.map((g) => `<div class="goal ${g.status}">${esc(g.text)}</div>`).join("")
      : `<div class="empty">No threads yet.</div>`;
}
const KIND_GLYPH = {
  weapon: "⚔", armor: "🛡", tool: "🔧", consumable: "🧪",
  keepsake: "✦", quest: "❖", misc: "•",
};
function renderInventory(inv) {
  $("#inventory").innerHTML =
    inv && inv.length
      ? inv
          .map((i) => {
            const glyph = KIND_GLYPH[i.kind] || "•";
            const marks =
              (i.equipped ? ' <span class="item-mark eq">equipped</span>' : "") +
              (i.significance ? ' <span class="item-mark imp" title="' + esc(i.significance) + '">★ important</span>' : "");
            const sub = i.desc || i.significance;
            return `<div class="inv-item"><b><span class="item-glyph">${glyph}</span> ${esc(i.name)}</b>${marks}${
              sub ? `<br><span class="meta">${esc(sub)}</span>` : ""
            }</div>`;
          })
          .join("")
      : `<div class="empty">Empty.</div>`;
}
function renderRelationships(npcs) {
  const box = $("#relationships");
  if (!npcs || !npcs.length) return (box.innerHTML = `<div class="empty">No one yet.</div>`);
  box.innerHTML = npcs
    .map((n) => {
      const r = n.relationshipToPlayer ?? 0;
      const pct = (r + 100) / 2;
      const color = r > 20 ? "var(--good)" : r < -20 ? "var(--bad)" : "var(--muted)";
      const items = n.items || [];
      const hasWeapon = items.some((i) => i.kind === "weapon");
      const carries = items.length
        ? `<div class="prof-row"><span class="prof-k">Carries</span><span class="prof-v">${items
            .map((i) => `${KIND_GLYPH[i.kind] || "•"} ${esc(i.name)}`)
            .join(", ")}</span></div>`
        : "";
      const prof = profileHTML(n.profile);
      const body = (prof || "") + (carries ? `<div class="profile">${carries}</div>` : "");
      const weaponMark = hasWeapon ? ' <span class="item-mark wpn" title="visibly armed">⚔</span>' : "";
      return `<div class="rel-wrap">
        <div class="rel-item${body ? " expandable" : ""}" data-id="${esc(n.id)}"><span class="rel-left">${portraitImg(n.id, n.name, "sm")}<span>${esc(n.name)}</span>${weaponMark}${body ? '<span class="caret">▾</span>' : ""}</span><div class="rel-bar"><span style="width:${pct}%;background:${color}"></span></div></div>
        ${body ? `<div class="rel-profile hidden">${body}</div>` : ""}
      </div>`;
    })
    .join("");
  // expand/collapse each NPC's profile
  box.querySelectorAll(".rel-item.expandable").forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest("img.portrait")) return; // portrait click → lightbox
      const body = row.parentElement.querySelector(".rel-profile");
      if (body) body.classList.toggle("hidden");
    };
  });
}

const COND_COLOR = {
  unharmed: "var(--good)",
  hurt: "var(--warn)",
  "badly hurt": "var(--bad)",
  down: "var(--bad)",
};
function condChip(label, condition) {
  return `<span class="cond" style="color:${COND_COLOR[condition] || "var(--muted)"}">${esc(label)}: ${esc(condition)}</span>`;
}
function renderEncounter(enc) {
  const strip = $("#encounter-strip");
  if (!enc || !enc.active) return strip.classList.add("hidden");
  const parts = (enc.participants || [])
    .map((p) => {
      const npc = (lastState?.npcs || []).find((n) => n.id === p.id);
      return condChip(npc ? npc.name : p.id, p.condition);
    })
    .join("");
  strip.innerHTML = `<span class="es-kind">⚔ ${esc(enc.kind)} · round ${enc.round}</span>${condChip("You", enc.playerCondition)}${parts}${enc.stakes ? `<span class="meta" style="color:var(--muted)">— ${esc(enc.stakes)}</span>` : ""}`;
  strip.classList.remove("hidden");
}
function renderActivity(act) {
  const strip = $("#activity-strip");
  if (!act || !act.active) return strip.classList.add("hidden");
  const names = (act.participants || [])
    .map((id) => (lastState?.npcs || []).find((n) => n.id === id)?.name || id)
    .join(", ");
  const icon = { drinks: "🍷", meal: "🍲", music: "🎵", game: "🎲", romance: "❤", rest: "🌙" }[act.kind] || "✦";
  strip.innerHTML = `<span class="es-kind">${icon} ${esc(act.kind)}${names ? ` with ${esc(names)}` : ""}</span>${act.summary ? `<span style="color:var(--muted)">— ${esc(act.summary)}</span>` : ""}`;
  strip.classList.remove("hidden");
}

async function loadGallery() {
  try {
    const { chapters } = await api("GET", `/api/story/${state.storyId}/chapters`);
    const g = $("#gallery-body");
    if (!chapters.length) return (g.innerHTML = `<div class="empty">Illustrations appear as you complete chapters.</div>`);
    const group = chapters.map((c) => ({
      src: chapterImgURL(c.index),
      caption: `Chapter ${c.index} — ${c.title}`,
    }));
    g.innerHTML = chapters
      .map(
        (c) =>
          `<div class="thumb" title="${esc(c.title)}"><img src="${chapterImgURL(c.index)}" alt=""/><div class="cap">Ch.${c.index}</div></div>`
      )
      .join("");
    g.querySelectorAll(".thumb img").forEach((img, i) => {
      zoomable(img, group[i].src, group[i].caption, group, i);
      watchImage(img, chapterImgURL(chapters[i].index), `${chapterImgURL(chapters[i].index)}/status`);
    });
  } catch (e) {
    /* ignore */
  }
}

// ---- World panel + intro card (v0.2 §6) ----
function renderWorld(world) {
  const box = $("#world-body");
  if (!box) return;
  if (!world) return (box.innerHTML = `<div class="empty">—</div>`);
  const bg = world.background;
  if (!bg) {
    box.innerHTML = `<div class="wp-overview">${esc(world.premise || "")}</div><div class="wp-item"><span>${esc(world.genre || "")} · ${esc(world.tone || "")}</span></div>`;
    return;
  }
  const list = (arr) =>
    (arr || [])
      .map((x) => `<div class="wp-item"><b>${esc(x.name)}</b> — <span>${esc(x.summary)}</span></div>`)
      .join("");
  box.innerHTML = `
    <div class="wp-overview">${esc(bg.overview || world.premise || "")}</div>
    ${bg.factions?.length ? `<h4>Factions</h4>${list(bg.factions)}` : ""}
    ${bg.places?.length ? `<h4>Places</h4>${list(bg.places)}` : ""}
    ${bg.history ? `<h4>History</h4><div class="wp-item"><span>${esc(bg.history)}</span></div>` : ""}
    ${bg.rules ? `<h4>How this world works</h4><div class="wp-item"><span>${esc(bg.rules)}</span></div>` : ""}`;
}

function addWorldCard(world) {
  if (!world) return;
  const bg = world.background;
  const overview = bg?.overview || world.premise || "";
  const card = el("div", "world-card");
  card.innerHTML = `
    <div class="wc-title">${esc(world.title || "Your world")}</div>
    <div class="wc-sub">${esc(world.genre || "")}${world.tone ? ` · ${esc(world.tone)}` : ""}</div>
    <div>${esc(overview)}</div>`;
  $("#feed").appendChild(card);
  scrollFeed();
}

async function exportEbook() {
  setStatus("#export-status", "Compiling your ebook…");
  $("#export-btn").disabled = true;
  try {
    const data = await api("POST", `/api/story/${state.storyId}/export`);
    setStatus("#export-status", "Ready!");
    window.open(data.url, "_blank");
  } catch (e) {
    setStatus("#export-status", e.message, true);
  } finally {
    $("#export-btn").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initOnboarding();
  setupLightbox();
});
