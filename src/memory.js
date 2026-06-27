// memory.js — weighted long-term memory store + retrieval (Technical Spec §8).
// Keeps long sessions coherent and affordable: remember what matters, let
// trivia fade. One file per story; small enough to load fully each turn.
import { v4 as uuid } from "uuid";
import { paths, readJSON, writeJSON } from "./storage.js";

// tunables (Spec §8.3 — tune by playtesting)
const REINFORCE = 8; // weight gained when referenced / goal-linked
const DECAY_RATE = 2; // weight lost per turn when untouched
const DECAY_AFTER = 4; // turns of dormancy before decay kicks in
const REPROMOTE = 15; // boost when a dormant entity re-enters the scene
const LINK_SHARE = 0.4; // fraction of a weight change shared to linked memories
const FLOOR = 10; // below this, summarize into a background note

export function loadMemories(storyId) {
  return readJSON(paths.memoryFile(storyId), {
    storyId,
    items: [],
    background: [],
  });
}

export function saveMemories(storyId, store) {
  writeJSON(paths.memoryFile(storyId), store);
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

// ---- create ---------------------------------------------------------------
// `defaultWitnesses` is used when the GM omits witnesses on a memory (typically
// everyone present in the scene this turn, plus "player").
export function addMemories(store, newMemories, currentTurn, defaultWitnesses = []) {
  const created = [];
  for (const m of newMemories || []) {
    const witnesses =
      m.witnesses && m.witnesses.length ? m.witnesses : [...defaultWitnesses];
    const item = {
      id: uuid(),
      storyId: store.storyId,
      type: m.type || "event",
      text: m.text,
      entities: m.entities || [],
      witnesses,
      weight: clamp(m.weight ?? 50),
      createdTurn: currentTurn,
      lastReferencedTurn: currentTurn,
      links: [],
    };
    store.items.push(item);
    created.push(item);
  }
  return created;
}

// ---- retrieve (per turn) --------------------------------------------------
// score = weight + relevanceBonus(entity overlap + recency)
export function retrieve(
  store,
  { sceneEntities = [], goalEntities = [], recentEntities = [], currentTurn = 0, k = 12 } = {}
) {
  const focus = new Set(
    [...sceneEntities, ...goalEntities, ...recentEntities]
      .filter(Boolean)
      .map((e) => e.toLowerCase())
  );

  const scored = store.items.map((m) => {
    let bonus = 0;
    const overlap = m.entities.filter((e) => focus.has(String(e).toLowerCase()));
    bonus += overlap.length * 12;
    // recency: a memory referenced within the last ~8 turns gets a fading bonus.
    const sinceRef = currentTurn - (m.lastReferencedTurn || 0);
    bonus += Math.max(0, 8 - sinceRef);
    return { m, score: m.weight + bonus, overlap: overlap.length };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.m);
}

// ---- weight updates (after each turn) -------------------------------------
export function updateWeights(store, { currentTurn, referencedIds = [], activeGoalEntities = [], sceneEntities = [] }) {
  const refSet = new Set(referencedIds);
  const goalEntset = new Set(activeGoalEntities.map((e) => String(e).toLowerCase()));
  const sceneSet = new Set(sceneEntities.map((e) => String(e).toLowerCase()));

  for (const m of store.items) {
    const before = m.weight;
    const referenced = refSet.has(m.id);
    const tiedToGoal = m.entities.some((e) => goalEntset.has(String(e).toLowerCase()));
    const dormant = currentTurn - (m.lastReferencedTurn || 0);

    if (referenced || tiedToGoal) {
      // Reinforce
      m.weight = clamp(m.weight + REINFORCE);
      m.lastReferencedTurn = currentTurn;
      // Re-promote: dormant entity back in the scene
      const reentered = m.entities.some((e) => sceneSet.has(String(e).toLowerCase()));
      if (reentered && dormant > DECAY_AFTER * 2) {
        m.weight = clamp(m.weight + REPROMOTE);
      }
    } else if (dormant > DECAY_AFTER) {
      // Decay untouched memories
      m.weight = clamp(m.weight - DECAY_RATE);
    }

    // Link: share a fraction of this change to linked memories
    const change = m.weight - before;
    if (change !== 0 && m.links?.length) {
      for (const linkedId of m.links) {
        const linked = store.items.find((x) => x.id === linkedId);
        if (linked) linked.weight = clamp(linked.weight + change * LINK_SHARE);
      }
    }
  }

  // Compress, don't delete: fold sub-floor memories into a rolling background note.
  const keep = [];
  for (const m of store.items) {
    if (m.weight < FLOOR && currentTurn - (m.lastReferencedTurn || 0) > DECAY_AFTER) {
      store.background = store.background || [];
      store.background.push(m.text);
    } else {
      keep.push(m);
    }
  }
  store.items = keep;
  // cap background note length
  if (store.background && store.background.length > 60) {
    store.background = store.background.slice(-60);
  }
  return store;
}

// Link related memories so weight changes ripple (Spec §8.3 "Linked").
export function linkMemories(store, ids) {
  const set = ids.filter(Boolean);
  for (const id of set) {
    const m = store.items.find((x) => x.id === id);
    if (!m) continue;
    for (const other of set) {
      if (other !== id && !m.links.includes(other)) m.links.push(other);
    }
  }
}

export const tunables = { REINFORCE, DECAY_RATE, DECAY_AFTER, REPROMOTE, FLOOR };
