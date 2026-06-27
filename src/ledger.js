// ledger.js — persistent World-State Ledger (v0.2 §4).
// Durable, structured facts the story must respect (possessions & provenance,
// locked/blocked things, established locations, promises/debts, deaths, and the
// outcomes of consequential checks — especially FAILURES). Unlike weighted
// memory, durable ledger facts never decay and are always injected into context.
import { randomUUID } from "node:crypto";
import { paths, readJSON, writeJSON } from "./storage.js";
import { normalizeName } from "./util.js";

export function loadLedger(storyId) {
  return readJSON(paths.ledgerFile(storyId), { storyId, facts: [] });
}

export function saveLedger(storyId, ledger) {
  writeJSON(paths.ledgerFile(storyId), ledger);
}

// Add a fact. De-dupes on near-identical text (active facts only).
export function addFact(ledger, { kind = "fact", text, entities = [], durable = false, turn = 0, chapter = 1 }) {
  if (!text) return null;
  const norm = normalizeName(text);
  const existing = ledger.facts.find(
    (f) => f.status === "active" && normalizeName(f.text) === norm
  );
  if (existing) {
    if (durable) existing.durable = true;
    return existing;
  }
  const fact = {
    id: randomUUID(),
    kind,
    text,
    entities,
    durable: !!durable,
    status: "active",
    createdTurn: turn,
    chapter,
  };
  ledger.facts.push(fact);
  return fact;
}

// Mark a fact superseded, matched by id or by (normalized) text substring.
export function resolveFact(ledger, ref) {
  const norm = normalizeName(ref);
  let n = 0;
  for (const f of ledger.facts) {
    if (f.status !== "active") continue;
    if (f.id === ref || normalizeName(f.text).includes(norm) || norm.includes(normalizeName(f.text))) {
      f.status = "superseded";
      n++;
    }
  }
  return n;
}

export function activeFacts(ledger) {
  return ledger.facts.filter((f) => f.status === "active");
}

// Record the outcome of a dice/skill check. Consequential failures (combat,
// theft, persuasion that gates an item/goal) are durable so they never decay.
export function recordCheckOutcome(ledger, { dice, text, entities = [], turn, chapter }) {
  const failed = /failure/.test(dice?.outcome || "");
  const durable = failed; // negative outcomes are the ones that get forgotten
  return addFact(ledger, {
    kind: "check_outcome",
    text:
      text ||
      `${dice.stat} check (DC ${dice.dc}) → ${String(dice.outcome).toUpperCase()}.`,
    entities,
    durable,
    turn,
    chapter,
  });
}

// Apply the worldState delta from a turn ({add:[...], resolve:[...]}).
export function applyWorldStateDelta(ledger, worldState, { turn, chapter }) {
  if (!worldState) return;
  for (const add of worldState.add || []) {
    addFact(ledger, {
      kind: add.kind || "fact",
      text: add.text,
      entities: add.entities || [],
      durable: !!add.durable,
      turn,
      chapter,
    });
  }
  for (const ref of worldState.resolve || []) resolveFact(ledger, ref);
}

// Snapshot the open durable facts (for chapter records / ebook continuity).
export function durableSnapshot(ledger) {
  return activeFacts(ledger)
    .filter((f) => f.durable)
    .map((f) => ({ kind: f.kind, text: f.text, chapter: f.chapter }));
}
