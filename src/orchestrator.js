// orchestrator.js — the main turn pipeline (Technical Spec §6).
import { paths, readJSON, writeJSON, appendTranscript, exists } from "./storage.js";
import { loadWorld } from "./worldGen.js";
import { preCheck, skillCheck } from "./dice.js";
import { buildSystemPrompt, buildMessages } from "./contextBuilder.js";
import { callGMStructured } from "./llm.js";
import { GMResponseSchema } from "./schemas.js";
import { applyDeltas } from "./stateExtractor.js";
import {
  loadMemories,
  saveMemories,
  retrieve,
  addMemories,
  updateWeights,
  linkMemories,
} from "./memory.js";
import { shouldCloseChapter, closeChapter } from "./chapters.js";
import { goalEntities, activeGoals } from "./goals.js";
import { nowISO, extractEntities } from "./util.js";
import {
  loadLedger,
  saveLedger,
  activeFacts,
  recordCheckOutcome,
  applyWorldStateDelta,
  addFact,
} from "./ledger.js";
import { composeImagePrompt } from "./imagePrompt.js";
import { migrateInventories, knownItems } from "./inventory.js";

// Turns kept inline in story.json for fast local context. Wider than a minimal
// window because continuity is the product's selling point (issues #1/#2).
const RECENT_WINDOW = 14;

// Load the full live bundle for a story.
export function loadBundle(storyId) {
  const story = readJSON(paths.storyFile(storyId));
  const world = loadWorld(story.worldId);
  const player = readJSON(paths.playerFile(storyId));
  const characters = new Map();
  characters.set(player.id, player);
  const npcs = [];
  for (const id of story.npcIds) {
    if (exists(paths.npcFile(storyId, id))) {
      const npc = readJSON(paths.npcFile(storyId, id));
      characters.set(npc.id, npc);
      npcs.push(npc);
    }
  }
  // v0.3 §5A — lazy migration: upgrade legacy player items + seed NPC
  // inventories from their profile loadout (pre-I2 saves load cleanly).
  migrateInventories({ story, npcs });
  return { story, world, player, npcs, characters };
}

// Run one player turn through the pipeline.
export async function runTurn(storyId, playerInput) {
  const { story, world, player, npcs, characters } = loadBundle(storyId);

  // --- 1. Pre-check: does this action need a dice/skill check? ---
  let diceResult = null;
  const check = await preCheck(playerInput, world.statSchema, story.scene.summary);
  if (check) {
    diceResult = skillCheck(player, check.stat, check.dc);
    diceResult.reason = check.reason;
  }

  // present cast at the START of the turn — used as default memory witnesses.
  const prePresent = [...story.scene.present];

  // --- 2. Build context (retrieve weighted memory + world-state ledger) ---
  const memStore = loadMemories(storyId);
  const ledger = loadLedger(storyId);
  const npcNames = npcs.map((n) => n.name);
  const sceneEntities = [
    story.scene.location,
    ...story.scene.present
      .map((id) => characters.get(id)?.name)
      .filter(Boolean),
  ];
  const gEntities = goalEntities(story.goals);
  const recentText = story.recentTurns
    .map((t) => `${t.playerInput} ${t.narration}`)
    .join(" ");
  const recentEntities = extractEntities(recentText, npcNames);

  const memories = retrieve(memStore, {
    sceneEntities,
    goalEntities: gEntities,
    recentEntities,
    currentTurn: story.turnCount,
    k: 12,
  });

  const systemPrompt = buildSystemPrompt(world);
  const messages = buildMessages({
    world,
    story,
    player,
    npcs,
    memories,
    ledgerFacts: activeFacts(ledger),
    diceResult,
    playerInput,
  });

  // --- 3. Call Claude → narration + structured deltas ---
  // (Nothing below this line mutates disk until the call succeeds — a failed
  //  turn leaves story.json/memory/ledger untouched; v0.2 §11.4.)
  // Generous budget so the late deltas fields (scene.present, chapterShouldEnd,
  // suggestedActions) never truncate (F5). Gemini further floors this via
  // GEMINI_MAX_OUTPUT_TOKENS.
  const gm = await callGMStructured(systemPrompt, messages, GMResponseSchema, 4096);

  // --- 4. State extractor: apply deltas ---
  story.turnCount += 1;
  const { newMemories, referencedMemories, encounterEnded, activityEnded, touchedCharacterIds } =
    applyDeltas({ story, characters, deltas: gm.deltas });

  // F4: anyone the GM modeled this turn is in the scene. Union the touched ids
  // additively into scene.present (the GM list is authoritative for who LEFT;
  // touched characters are re-added on top) so the mental panel shows the full
  // cast and presence self-heals + persists for the next turn's context.
  {
    const present = new Set(story.scene.present || []);
    for (const id of touchedCharacterIds || []) if (characters.has(id)) present.add(id);
    story.scene.present = [...present];
  }

  // --- 4b. World-state ledger: check outcomes, deltas, encounter/activity facts ---
  if (diceResult) {
    recordCheckOutcome(ledger, {
      dice: diceResult,
      text: `Check (${diceResult.stat} DC ${diceResult.dc}) on "${playerInput.slice(0, 70)}" → ${String(diceResult.outcome).toUpperCase()}.`,
      turn: story.turnCount,
      chapter: story.chapter.index,
    });
  }
  applyWorldStateDelta(ledger, gm.deltas?.worldState, {
    turn: story.turnCount,
    chapter: story.chapter.index,
  });
  if (encounterEnded)
    addFact(ledger, { kind: "fact", text: encounterEnded, durable: true, turn: story.turnCount, chapter: story.chapter.index });
  if (activityEnded)
    addFact(ledger, { kind: "fact", text: activityEnded, durable: false, turn: story.turnCount, chapter: story.chapter.index });
  saveLedger(storyId, ledger);

  // --- 5. Memory manager: create / reinforce / decay / link ---
  // Default witnesses for memories the GM didn't tag = everyone in the scene
  // this turn (before + after any scene change) plus the player.
  const defaultWitnesses = [
    ...new Set(["player", ...prePresent, ...story.scene.present]),
  ];
  const created = addMemories(memStore, newMemories, story.turnCount, defaultWitnesses);
  // Link: memories born together this turn, and the ones the GM leaned on, share
  // weight changes going forward (Spec §6.5/§8.3 "Linked").
  linkMemories(memStore, [...created.map((m) => m.id), ...referencedMemories]);
  updateWeights(memStore, {
    currentTurn: story.turnCount,
    referencedIds: referencedMemories,
    activeGoalEntities: gEntities,
    sceneEntities,
  });
  saveMemories(storyId, memStore);

  // --- 5b. Scene/action image decision (off the turn path; v0.2 §9) ---
  // Action/fight moments are prioritized; non-action scenes are budgeted per
  // chapter. The image renders lazily via GET /api/story/:id/scene/:turnIndex.
  const sceneImage = decideSceneImage({ story, world, player, characters, deltas: gm.deltas });

  // --- 6. Record the turn ---
  // F9: drop suggested actions that just repeat last turn's options (safety net behind
  // the contextBuilder anti-repeat guard); keep originals if dedup would leave < 2.
  const prevActions =
    story.recentTurns[story.recentTurns.length - 1]?.suggestedActions || [];
  const suggestedActions = dedupeActions(gm.suggestedActions || [], prevActions);

  const turn = {
    index: story.turnCount,
    chapter: story.chapter.index,
    playerInput,
    narration: gm.narration,
    ask: gm.ask,
    suggestedActions,
    diceResult: diceResult || undefined,
    sceneImage: sceneImage || undefined,
    at: nowISO(),
  };
  appendTranscript(storyId, turn);
  story.recentTurns.push(turn);
  if (story.recentTurns.length > RECENT_WINDOW) {
    story.recentTurns = story.recentTurns.slice(-RECENT_WINDOW);
  }

  // beat = a player-driven story turn
  story.chapter.beatCount += 1;

  // --- 7. Chapter manager ---
  let chapterComplete = null;
  const { close, forced } = shouldCloseChapter(story, gm.deltas?.chapterShouldEnd);
  if (close) {
    // refresh player from characters map (mental status may have changed)
    const freshPlayer = characters.get(player.id) || player;
    chapterComplete = await closeChapter(world, story, freshPlayer, characters, { forced });
  }

  // --- 8. Persist save ---
  story.updatedAt = nowISO();
  writeJSON(paths.storyFile(storyId), story);

  // --- 9. Return state for the UI ---
  return {
    narration: gm.narration,
    ask: gm.ask,
    suggestedActions,
    // false only when the GM is continuing one uninterrupted beat; the UI may
    // auto-continue (capped) instead of waiting for input.
    needsPlayerInput: gm.deltas?.needsPlayerInput !== false,
    diceResult,
    sceneImage: sceneImage || null,
    chapterComplete,
    state: deriveUIState(story, characters),
  };
}

// Decide whether this turn gets a scene/action image and compose its prompt.
// Returns a sceneImage record { path, kind, priority, prompt } or null.
function decideSceneImage({ story, world, player, characters, deltas }) {
  const provider = (process.env.IMAGE_PROVIDER || "none").toLowerCase();
  const mode = (process.env.SCENE_IMAGES || (provider === "none" ? "off" : "auto")).toLowerCase();
  if (mode === "off" || provider === "none") return null;
  const ill = deltas?.illustrate;
  if (!ill?.should || ill.kind === "none" || !ill.prompt) return null;

  const budget = Number(process.env.SCENE_IMAGE_BUDGET || 3);
  if (story.chapter.sceneImages == null) story.chapter.sceneImages = 0;
  const isAction = ill.kind === "action";
  // Action/fight is prioritized (always rendered); other scenes are budgeted.
  if (!isAction && story.chapter.sceneImages >= budget) return null;

  const present = story.scene.present
    .map((id) => characters.get(id))
    // exclude the player so they aren't listed twice in the image prompt (F4b)
    .filter((c) => c && !c.isPlayer && c.id !== story.playerId);
  const { prompt } = composeImagePrompt({
    world,
    characters: [player, ...present],
    moment: ill.prompt,
  });
  story.chapter.sceneImages += 1;
  return {
    path: paths.sceneImageRel(story.storyId, story.turnCount),
    kind: ill.kind,
    priority: ill.priority ?? 50,
    prompt,
  };
}

// Compose the panels the UI renders from current state.
export function deriveUIState(story, characters) {
  const player = characters.get(story.playerId);
  const present = story.scene.present
    .map((id) => characters.get(id))
    // exclude the player — they render in their own panel, never as an "NPC in scene" (F4b)
    .filter((c) => c && !c.isPlayer && c.id !== story.playerId)
    .map(npcView);
  // all known NPCs for relationship tracker
  const allNpcs = [...characters.values()]
    .filter((c) => !c.isPlayer)
    .map(npcView);

  return {
    storyId: story.storyId,
    title: story.title,
    scene: story.scene,
    chapter: story.chapter,
    turnCount: story.turnCount,
    inventory: story.inventory,
    goals: story.goals,
    player: player ? playerView(player) : null,
    npcsInScene: present,
    npcs: allNpcs,
    encounter: story.encounter || null,
    activity: story.activity || null,
  };
}

function playerView(p) {
  return {
    id: p.id,
    name: p.displayName || p.name,
    role: p.role,
    stats: p.stats,
    mentalStatus: p.mentalStatus,
    canon: p.canon || [],
    profile: p.profile || {},
    hasPortrait: !!p.portraitPath,
  };
}

// F9: remove suggested actions that exactly or near-duplicate the previous turn's, so the
// player isn't shown the same move two rounds running. Near-dup = ≥60% token overlap.
// Falls back to the originals if dedup would leave fewer than 2 options.
function dedupeActions(actions, prevActions) {
  const norm = (s) =>
    String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const prevNorm = (prevActions || []).map(norm);
  const prevTokens = prevNorm.map((s) => new Set(s.split(" ").filter(Boolean)));
  const isDup = (a) => {
    const an = norm(a);
    if (!an) return false;
    if (prevNorm.includes(an)) return true;
    const at = new Set(an.split(" ").filter(Boolean));
    return prevTokens.some((pt) => {
      const inter = [...at].filter((w) => pt.has(w)).length;
      return inter / Math.max(at.size, pt.size, 1) >= 0.6;
    });
  };
  const kept = (actions || []).filter((a) => !isDup(a));
  return kept.length >= 2 ? kept : actions || [];
}
function npcView(n) {
  return {
    id: n.id,
    name: n.displayName || n.name,
    role: n.role,
    relationshipToPlayer: n.relationshipToPlayer ?? 0,
    mentalStatus: n.mentalStatus,
    profile: n.profile || {},
    items: knownItems(n.inventory), // v0.3 §5A — only non-concealed carried items
    hasPortrait: !!n.portraitPath,
  };
}
