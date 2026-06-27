// stateExtractor.js — apply Claude's structured deltas → state updates (Spec §6 step 4).
// v0.2: character-name dedupe registry (§3), hardened resolution, and
// encounter/activity lifecycle application (§10, §10A).
import { v4 as uuid } from "uuid";
import { paths, writeJSON } from "./storage.js";
import { applyMentalDelta, defaultMentalStatus } from "./mentalStatus.js";
import { applyGoalDeltas } from "./goals.js";
import { normalizeName, nameTokens, isRelationalVariant, cleanCharacterName } from "./util.js";
import { startEncounter, applyRound, endEncounter } from "./encounter.js";
import { startActivity, continueActivity, endActivity } from "./activity.js";
import { makeItem, seedFromProfile, inventoryOf, findItem, isPlayerRef } from "./inventory.js";

// Build a canonical character resolver over the loaded characters (§3.4).
// Resolution order: exact id → exact normalized name/displayName/alias →
// null (ignored) when ambiguous, so a bad reference never mutates the wrong one.
function buildResolver(characters) {
  const byNorm = new Map(); // normalized name -> [character]
  const index = (c) => {
    for (const nm of [c.name, c.displayName, ...(c.aliases || [])]) {
      if (!nm) continue;
      const k = normalizeName(nm);
      if (!byNorm.has(k)) byNorm.set(k, []);
      const arr = byNorm.get(k);
      if (!arr.includes(c)) arr.push(c);
    }
  };
  for (const c of characters.values()) index(c);

  // F6: guarded fuzzy match — used ONLY after an exact-name miss. Matches a name
  // variant/epithet to an existing character (core name + shared first token +
  // token-subset), but never across a relational marker, and never when it's
  // ambiguous (matches >1) — so existing behavior is unchanged for the common case.
  const fuzzyMatch = (ref) => {
    const refTokens = nameTokens(ref);
    if (!refTokens.length) return null;
    const hits = new Set();
    for (const c of characters.values()) {
      for (const nm of [c.name, c.displayName, ...(c.aliases || [])]) {
        if (!nm) continue;
        if (isRelationalVariant(ref, nm)) continue; // Ceth vs Ceth's Daughter → never
        const cTokens = nameTokens(nm);
        if (!cTokens.length || cTokens[0] !== refTokens[0]) continue;
        const setRef = new Set(refTokens);
        const setC = new Set(cTokens);
        const refSubsetOfC = refTokens.every((t) => setC.has(t));
        const cSubsetOfRef = cTokens.every((t) => setRef.has(t));
        if (refSubsetOfC || cSubsetOfRef) {
          hits.add(c);
          break;
        }
      }
    }
    return hits.size === 1 ? [...hits][0] : null; // ambiguity → no match
  };

  const resolveChar = (ref) => {
    if (!ref) return null;
    if (characters.has(ref)) return characters.get(ref);
    const arr = byNorm.get(normalizeName(ref));
    if (arr && arr.length === 1) return arr[0];
    if (arr && arr.length > 1) {
      // ambiguous exact name: only a precise name/displayName match wins
      const exact = arr.find(
        (c) =>
          normalizeName(c.displayName || c.name) === normalizeName(ref) ||
          normalizeName(c.name) === normalizeName(ref)
      );
      return exact || null;
    }
    // exact miss → guarded fuzzy pass (variants/epithets)
    const fuzzy = fuzzyMatch(ref);
    if (fuzzy) return fuzzy;
    // F10: placeholder/id token ("orrath_id", "<npcId>", "npc_orrath") → strip + retry
    const cleaned = cleanCharacterName(ref);
    if (cleaned && normalizeName(cleaned) !== normalizeName(ref)) {
      const arr2 = byNorm.get(normalizeName(cleaned));
      if (arr2 && arr2.length === 1) return arr2[0];
      return fuzzyMatch(cleaned);
    }
    return null;
  };
  const resolveRef = (ref) => resolveChar(ref)?.id ?? null;
  return { resolveChar, resolveRef, index, byNorm };
}

// Merge a re-introduced NPC into the existing character: fill empty fields,
// append new canon (never overwrite established canon), record an alias.
function mergeIntoExisting(existing, npc) {
  if (!existing.role && npc.role) existing.role = npc.role;
  if ((!existing.stats || !Object.keys(existing.stats).length) && npc.stats && Object.keys(npc.stats).length)
    existing.stats = npc.stats;
  if (!existing.visualDescriptor && npc.visualDescriptor)
    existing.visualDescriptor = npc.visualDescriptor;
  if (!existing.persona && npc.persona) existing.persona = npc.persona;
  if (npc.profile && Object.keys(npc.profile).length) {
    existing.profile = mergeProfile(existing.profile, npc.profile);
  }
  if (Array.isArray(npc.canon)) {
    existing.canon = existing.canon || [];
    for (const fact of npc.canon) if (fact && !existing.canon.includes(fact)) existing.canon.push(fact);
  }
  // seed inventory if the existing character has none yet (v0.3 §5A)
  if (!Array.isArray(existing.inventory)) existing.inventory = [];
  if (existing.inventory.length === 0) {
    if (Array.isArray(npc.inventory) && npc.inventory.length) existing.inventory = npc.inventory.map(makeItem);
    else existing.inventory = seedFromProfile(npc.profile || existing.profile);
  }
  if (npc.name && normalizeName(npc.name) !== normalizeName(existing.name)) {
    existing.aliases = existing.aliases || [];
    if (!existing.aliases.some((a) => normalizeName(a) === normalizeName(npc.name)))
      existing.aliases.push(npc.name);
  }
}

// Apply deltas in place to story + characters. Returns { newMemories,
// referencedMemories, newNpcCharacters, encounterEnded, activityEnded,
// touchedCharacterIds }.
export function applyDeltas({ story, characters, deltas }) {
  deltas = deltas || {};
  const reg = buildResolver(characters);
  const resolveRef = reg.resolveRef;
  // F4: every NPC the GM models this turn (mental/relationship/new/encounter/
  // activity) is, by definition, in the scene — collected so the orchestrator
  // can union them into scene.present even if the GM forgot to list them.
  const touched = new Set();

  // --- 1. new NPCs (dedupe by name; assign ids only for genuinely new people) ---
  const newNpcCharacters = [];
  for (const npc of deltas.newNpcs || []) {
    if (!npc?.name) continue;
    // F10: a placeholder/id token in the NAME field means "reference an existing
    // character", not "create a new one". Clean it; skip pure placeholders entirely so
    // they never become a hollow duplicate (e.g. the "orrath_id" bug).
    const cleanName = cleanCharacterName(npc.name);
    if (!cleanName) continue; // e.g. "<npcId>" → ignore
    if (normalizeName(cleanName) !== normalizeName(npc.name))
      npc.name = cleanName.replace(/\b\w/g, (c) => c.toUpperCase()); // title-case the bare name
    // never let a placeholder-looking id become a new character id
    if (npc.id && (/[<>]/.test(npc.id) || /[ _-]id$/i.test(npc.id))) npc.id = undefined;

    // existing by explicit id, else by name (resolveChar also strips placeholder tokens)
    let existing =
      npc.id && characters.has(npc.id) ? characters.get(npc.id) : reg.resolveChar(npc.name);

    // genuine different person with same name only if GM supplied a distinct displayName
    const wantsDistinct =
      existing &&
      npc.displayName &&
      normalizeName(npc.displayName) !== normalizeName(existing.displayName || existing.name);

    if (existing && !wantsDistinct) {
      mergeIntoExisting(existing, npc);
      reg.index(existing);
      writeJSON(paths.npcFile(story.storyId, existing.id), existing);
      continue; // no new id / file
    }

    // create a new character; ensure a unique display name (auto-suffix if needed)
    let displayName = npc.displayName || npc.name;
    let suffix = 2;
    while (reg.resolveChar(displayName)) {
      displayName = `${npc.displayName || npc.name} (${suffix++})`;
    }
    const id = npc.id && !characters.has(npc.id) ? npc.id : `npc_${uuid().slice(0, 8)}`;
    const char = {
      id,
      name: npc.name,
      displayName,
      aliases: [],
      role: npc.role || "",
      stats: npc.stats || {},
      mentalStatus: npc.mentalStatus || defaultMentalStatus(),
      relationshipToPlayer: npc.relationshipToPlayer ?? 0,
      visualDescriptor: npc.visualDescriptor || "",
      persona: npc.persona || "",
      canon: Array.isArray(npc.canon) ? npc.canon : [],
      profile: npc.profile || {},
      // v0.3 §5A — starting items from the delta, else seeded from the profile loadout.
      inventory:
        Array.isArray(npc.inventory) && npc.inventory.length
          ? npc.inventory.map(makeItem)
          : seedFromProfile(npc.profile),
      portraitPath: null,
      // F11 — who this new NPC already knows by name (resolved to ids)
      knownCharacters: (npc.knownCharacters || [])
        .map((ref) => (isPlayerRef(ref, story) ? story.playerId : reg.resolveRef(ref)))
        .filter(Boolean),
      isPlayer: false,
    };
    characters.set(id, char);
    reg.index(char);
    newNpcCharacters.push(char);
    touched.add(id);
    if (!story.npcIds.includes(id)) story.npcIds.push(id);
    writeJSON(paths.npcFile(story.storyId, id), char);
  }

  // --- 2. mental-status deltas ---
  for (const [ref, dimDelta] of Object.entries(deltas.mentalStatus || {})) {
    const c = reg.resolveChar(ref);
    if (c) {
      applyMentalDelta(c, dimDelta);
      if (!c.isPlayer) touched.add(c.id);
    }
  }

  // --- 3. relationship deltas (NPCs) ---
  for (const [ref, change] of Object.entries(deltas.relationships || {})) {
    const c = reg.resolveChar(ref);
    if (c && !c.isPlayer) {
      c.relationshipToPlayer = clamp((c.relationshipToPlayer ?? 0) + Number(change || 0), -100, 100);
      touched.add(c.id);
    }
  }

  // --- 4. per-character inventory + transfers (v0.3 §5A) ---
  applyInventory({ story, characters, reg, deltas });

  // --- 5. scene ---
  if (deltas.scene && Object.keys(deltas.scene).length) {
    const s = deltas.scene;
    if (s.location) story.scene.location = s.location;
    if (s.timeOfDay) story.scene.timeOfDay = s.timeOfDay;
    if (s.summary) story.scene.summary = s.summary;
    if (Array.isArray(s.present)) {
      // Resolve-or-create: a present ref that names an unknown character becomes
      // a real (minimal) NPC rather than being silently dropped (F4.4).
      const ids = [];
      for (const ref of s.present) {
        let c = reg.resolveChar(ref);
        if (!c && ref) c = createMinimalNpc(ref, story, characters, reg);
        if (c) ids.push(c.id);
      }
      story.scene.present = [...new Set(ids)];
    }
  }

  // --- 6. goals ---
  if (deltas.goals) {
    story.goals = applyGoalDeltas(story.goals, deltas.goals, story.turnCount);
  }

  // --- 6b. canon facts ---
  for (const [ref, facts] of Object.entries(deltas.canonFacts || {})) {
    const c = reg.resolveChar(ref);
    if (!c) continue;
    if (!Array.isArray(c.canon)) c.canon = [];
    for (const fact of facts || []) if (fact && !c.canon.includes(fact)) c.canon.push(fact);
  }

  // --- 6b2. profile updates (field-wise merge; never silently overwrite) ---
  for (const [ref, update] of Object.entries(deltas.profileUpdate || {})) {
    const c = reg.resolveChar(ref);
    if (!c) continue;
    c.profile = mergeProfile(c.profile, update);
  }

  // --- 6b3. introductions: characters who learned each other's names (F11) ---
  for (const group of deltas.introductions || []) {
    const ids = (group || [])
      .map((ref) => (isPlayerRef(ref, story) ? story.playerId : resolveRef(ref)))
      .filter(Boolean);
    for (const a of ids) {
      const c = characters.get(a);
      if (!c) continue;
      if (!Array.isArray(c.knownCharacters)) c.knownCharacters = [];
      for (const b of ids) {
        if (b !== a && !c.knownCharacters.includes(b)) c.knownCharacters.push(b);
      }
    }
  }

  // --- 6c. encounter lifecycle (v0.2 §10) ---
  if (deltas.encounter?.start) startEncounter(story, deltas.encounter.start, resolveRef);
  if (deltas.encounter?.round) applyRound(story, deltas.encounter.round, resolveRef);
  let encounterEnded = null;
  if (deltas.encounter?.end) encounterEnded = endEncounter(story, deltas.encounter.end);

  // --- 6d. activity lifecycle (v0.2 §10A) ---
  if (deltas.activity?.start) startActivity(story, deltas.activity.start, resolveRef);
  if (deltas.activity?.beat) continueActivity(story, deltas.activity.beat);
  let activityEnded = null;
  if (deltas.activity?.end) activityEnded = endActivity(story, deltas.activity.end);

  // encounter/activity participants are in the scene too
  for (const p of story.encounter?.participants || []) if (p?.id) touched.add(p.id);
  for (const id of story.activity?.participants || []) if (id) touched.add(id);

  // --- 7. persist all touched characters ---
  for (const c of characters.values()) {
    const file = c.isPlayer ? paths.playerFile(story.storyId) : paths.npcFile(story.storyId, c.id);
    writeJSON(file, c);
  }

  return {
    touchedCharacterIds: [...touched].filter((id) => {
      const c = characters.get(id);
      return c && !c.isPlayer;
    }),
    newMemories: deltas.newMemories || [],
    referencedMemories: deltas.referencedMemories || [],
    newNpcCharacters,
    encounterEnded,
    activityEnded,
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Create a minimal NPC for a present ref that named no known character, so a
// character active in the scene never silently vanishes (F4.4). Skips id-like /
// stale refs (those are bad ids, not new people).
function createMinimalNpc(ref, story, characters, reg) {
  const name = String(ref).trim();
  if (!name || /^npc_/i.test(name) || normalizeName(name) === "player") return null;
  let displayName = name;
  let n = 2;
  while (reg.resolveChar(displayName)) displayName = `${name} (${n++})`;
  const id = `npc_${uuid().slice(0, 8)}`;
  const char = {
    id,
    name,
    displayName,
    aliases: [],
    role: "",
    stats: {},
    mentalStatus: defaultMentalStatus(),
    relationshipToPlayer: 0,
    visualDescriptor: "",
    persona: "",
    canon: [],
    profile: {},
    inventory: [],
    portraitPath: null,
    isPlayer: false,
  };
  characters.set(id, char);
  reg.index(char);
  if (!story.npcIds.includes(id)) story.npcIds.push(id);
  writeJSON(paths.npcFile(story.storyId, id), char);
  return char;
}

// ---- per-character inventory (v0.3 §5A) -----------------------------------
// Normalize `deltas.inventory` into a map of charRef → { add, remove }. Accepts
// the legacy player form `{ add, remove }` and the per-character map.
function normalizeInventoryDelta(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  // top-level add/remove → the player (legacy form), even if mixed with per-char keys
  if (Array.isArray(raw.add) || Array.isArray(raw.remove)) {
    out.player = { add: raw.add || [], remove: raw.remove || [] };
  }
  // any other key mapping to an { add/remove } object → that character
  for (const [ref, op] of Object.entries(raw)) {
    if (ref === "add" || ref === "remove") continue;
    if (op && typeof op === "object" && (Array.isArray(op.add) || Array.isArray(op.remove))) {
      out[ref] = { add: op.add || [], remove: op.remove || [] };
    }
  }
  return out;
}

function removeFromInv(inv, id) {
  const i = inv.findIndex((x) => x.id === id);
  if (i >= 0) inv.splice(i, 1);
}

// Losing a keepsake / significant item hits the owner's mental status (v0.3 §5A.8).
function onItemLost(item, ownerId, characters, story) {
  if (!item || (!item.significance && item.kind !== "keepsake")) return;
  const owner = isPlayerRef(ownerId, story)
    ? characters.get(story.playerId || "player")
    : characters.get(ownerId);
  if (owner) applyMentalDelta(owner, { Morale: -8, Stress: 8 });
}

function refToId(ref, story, reg) {
  return isPlayerRef(ref, story) ? story.playerId || "player" : reg.resolveRef(ref);
}

function applyInventory({ story, characters, reg, deltas }) {
  // add / remove, routed per character
  for (const [ref, op] of Object.entries(normalizeInventoryDelta(deltas.inventory))) {
    const id = refToId(ref, story, reg);
    if (!id) continue;
    const inv = inventoryOf(id, story, characters);
    if (!inv) continue;
    for (const add of op.add || []) {
      const item = makeItem(add);
      if (item.name) inv.push(item);
    }
    for (const rem of op.remove || []) {
      const found = findItem(inv, rem);
      if (found) {
        removeFromInv(inv, found.id);
        onItemLost(found, id, characters, story);
      }
    }
  }

  // transfers (give / loot / steal) — relocate the same item between characters
  for (const t of deltas.transfer || []) {
    const fromId = refToId(t.from, story, reg);
    const toId = refToId(t.to, story, reg);
    if (!fromId || !toId || fromId === toId) continue;
    const fromInv = inventoryOf(fromId, story, characters);
    const toInv = inventoryOf(toId, story, characters);
    if (!fromInv || !toInv) continue;
    const item = findItem(fromInv, t.item);
    if (!item) continue;
    removeFromInv(fromInv, item.id);
    onItemLost(item, fromId, characters, story);
    item.equipped = false; // re-equip is a separate, deliberate act
    toInv.push(item);
  }
}

// Field-wise profile merge (v0.3 §5.6): scalars replace, objects shallow-merge,
// arrays upsert (object items by `name`, strings as a union) — additive, never
// a silent wholesale overwrite.
function mergeProfile(existing, update) {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(update || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) out[k] = mergeArray(out[k] || [], v);
    else if (typeof v === "object") out[k] = { ...(out[k] || {}), ...v };
    else out[k] = v;
  }
  return out;
}
function mergeArray(cur, add) {
  const out = Array.isArray(cur) ? [...cur] : [];
  for (const item of add) {
    if (typeof item === "string") {
      if (!out.includes(item)) out.push(item);
    } else if (item && item.name) {
      const i = out.findIndex((x) => x && x.name === item.name);
      if (i >= 0) out[i] = { ...out[i], ...item };
      else out.push(item);
    } else {
      out.push(item);
    }
  }
  return out;
}
