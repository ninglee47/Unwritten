// dice.js — roll + skill-check resolution (Technical Spec §7).
// Claude never overrides a roll — it dramatizes it.
import { callClassify, extractJSON } from "./llm.js";
import { mentalStatusModifier } from "./mentalStatus.js";

const DC_TIERS = { Easy: 8, Medium: 12, Hard: 16, Heroic: 20 };

export function rollD20() {
  return 1 + Math.floor(Math.random() * 20);
}

// D&D-style modifier from a stat value (10 = +0).
export function statModifier(character, stat) {
  const val = character?.stats?.[stat];
  if (typeof val !== "number") return 0;
  return Math.floor((val - 10) / 2);
}

// Resolve a check for `character` using `stat` against difficulty `dc`.
export function skillCheck(character, stat, dc, situationalModifier = 0) {
  const d20 = rollD20();
  const statMod = statModifier(character, stat);
  const mentalMod = mentalStatusModifier(character, stat);
  const total = d20 + statMod + mentalMod + situationalModifier;

  let outcome;
  if (d20 === 1) outcome = "critical failure";
  else if (total >= dc + 10) outcome = "critical success";
  else if (total >= dc) outcome = "success";
  else if (total >= dc - 4) outcome = "partial success";
  else outcome = "failure";

  return {
    stat,
    dc,
    d20,
    statMod,
    mentalMod,
    situationalModifier,
    total,
    outcome,
  };
}

const CLASSIFY_SYSTEM = `You decide whether a player's action in a role-playing game needs a dice/skill check.
A check is needed ONLY when the outcome is uncertain AND meaningful (combat, persuasion against resistance, stealth, risky feats, lock-picking, etc.). Routine, low-stakes actions (walking, talking casually, looking around) need NO check.
Reply with ONLY a fenced json block:
{"needsCheck": true|false, "stat": "<one of the world's stats>", "dc": <8-20>, "reason": "<short>"}
Choose dc by difficulty: Easy 8, Medium 12, Hard 16, Heroic 20.`;

// Ask the cheap model whether this action needs a check. Fails open (no check).
export async function preCheck(playerInput, statSchema, sceneSummary) {
  try {
    const user = `Stats available: ${statSchema.join(", ")}.
Scene: ${sceneSummary || "(none)"}
Player action: "${playerInput}"`;
    const raw = await callClassify(CLASSIFY_SYSTEM, user);
    const parsed = extractJSON(raw);
    if (!parsed || !parsed.needsCheck) return null;
    const stat = statSchema.includes(parsed.stat) ? parsed.stat : statSchema[0];
    let dc = Number(parsed.dc);
    if (!Number.isFinite(dc)) dc = DC_TIERS.Medium;
    dc = Math.max(5, Math.min(22, dc));
    return { stat, dc, reason: parsed.reason || "" };
  } catch {
    return null; // never block a turn on classification failure
  }
}

export { DC_TIERS };
