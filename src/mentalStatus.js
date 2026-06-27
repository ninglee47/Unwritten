// mentalStatus.js — mental-status model + modifiers (Product Spec §6A.3).
// Mental status is a first-class factor: it modifies skill checks, shapes
// dialogue/narration, and evolves dynamically. Centralized here.

export const DIMENSIONS = ["Stress", "Morale", "Trust", "Composure"];

export function defaultMentalStatus() {
  return {
    state: "calm",
    dimensions: { Stress: 20, Morale: 60, Trust: 50, Composure: 70 },
    notes: "",
  };
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

// Map a character's mental state/dimensions to a numeric modifier for a check.
// Composure-based actions (e.g. Resolve, Charisma under pressure) are most
// affected; high morale gives a small all-round boost.
export function mentalStatusModifier(character, stat) {
  const dims = character?.mentalStatus?.dimensions || {};
  const composure = dims.Composure ?? 70;
  const morale = dims.Morale ?? 60;
  const stress = dims.Stress ?? 20;

  let mod = 0;

  // Composure dominates "nerve" stats.
  const nerveStats = ["Resolve", "Composure", "Wits", "Charisma"];
  if (nerveStats.includes(stat)) {
    if (composure < 30) mod -= 3;
    else if (composure < 50) mod -= 1;
    else if (composure > 85) mod += 1;
  }

  // Morale is a general tailwind / headwind.
  if (morale > 80) mod += 2;
  else if (morale < 25) mod -= 2;

  // High stress frays everything.
  if (stress > 80) mod -= 2;
  else if (stress > 60) mod -= 1;

  return mod;
}

// Apply a delta map ({Stress:+10, Trust:-5}) to a character's mental status,
// clamping dimensions and refreshing the headline label.
export function applyMentalDelta(character, delta) {
  if (!character.mentalStatus) character.mentalStatus = defaultMentalStatus();
  const dims = character.mentalStatus.dimensions;
  for (const [k, v] of Object.entries(delta || {})) {
    if (dims[k] === undefined) dims[k] = 50;
    dims[k] = clamp(dims[k] + v);
  }
  character.mentalStatus.state = deriveState(dims);
  return character;
}

// Derive a human-readable headline state from the dimensions.
export function deriveState(dims) {
  const { Stress = 20, Morale = 60, Composure = 70 } = dims || {};
  if (Composure < 25) return "panicked";
  if (Stress > 80) return "overwhelmed";
  if (Stress > 60 && Composure < 50) return "afraid";
  if (Morale < 25) return "despairing";
  if (Morale > 85 && Stress < 30) return "inspired";
  if (Composure > 80 && Morale > 65) return "confident";
  if (Stress > 50) return "tense";
  if (Morale < 45) return "weary";
  return "calm";
}

// One-line summary for prompt context.
export function summarize(character) {
  const ms = character?.mentalStatus;
  if (!ms) return "";
  const d = ms.dimensions || {};
  const dimsStr = DIMENSIONS.map((k) => `${k} ${d[k] ?? "?"}`).join(", ");
  return `${ms.state} (${dimsStr})${ms.notes ? ` — ${ms.notes}` : ""}`;
}
