// encounter.js — lightweight combat/action "encounter mode" (v0.2 §10).
// Story-first: a small Condition track (unharmed → hurt → badly hurt → down),
// not HP bars. Round checks run through the existing dice.js; condition changes
// arrive as deltas and are applied here. Mental status feeds checks both ways.
import { statModifier } from "./dice.js";
import { mentalStatusModifier } from "./mentalStatus.js";

export const CONDITIONS = ["unharmed", "hurt", "badly hurt", "down"];

// DC for a contested action against a defender (v0.2 §10.2):
//   DC = 10 + statModifier(defender, opposingStat) + mentalStatusModifier(defender)
export function contestedDC(defender, opposingStat) {
  return (
    10 + statModifier(defender, opposingStat) + mentalStatusModifier(defender, opposingStat)
  );
}

// Begin an encounter on the story (resolveRef maps GM names→ids).
export function startEncounter(story, { kind = "combat", participants = [], stakes = "" }, resolveRef) {
  const ids = participants.map((p) => resolveRef(p)).filter(Boolean);
  story.encounter = {
    active: true,
    kind,
    round: 1,
    participants: ids.map((id) => ({ id, condition: "unharmed" })),
    playerCondition: "unharmed",
    stakes,
  };
  return story.encounter;
}

// Apply per-round condition changes. `changes` maps participant id (or "player")
// → new condition. Advances the round counter.
export function applyRound(story, changes, resolveRef) {
  const enc = story.encounter;
  if (!enc) return;
  for (const [ref, condition] of Object.entries(changes || {})) {
    if (!CONDITIONS.includes(condition)) continue;
    if (ref === "player" || ref === story.playerId) {
      enc.playerCondition = condition;
      continue;
    }
    const id = resolveRef(ref);
    let p = enc.participants.find((x) => x.id === id);
    if (!p && id) {
      p = { id, condition: "unharmed" };
      enc.participants.push(p);
    }
    if (p) p.condition = condition;
  }
  enc.round += 1;
}

// End the encounter; returns a one-line result for the ledger, clears the block.
export function endEncounter(story, { outcome = "", summary = "" } = {}) {
  const enc = story.encounter;
  story.encounter = null;
  const kind = enc?.kind || "fight";
  return `Encounter (${kind}) ended: ${outcome || summary || "resolved"}.`;
}
