// goals.js — loose goals / quests (Product Spec §3.4, Technical Spec §5.5).
// Suggestions, not rails. They evolve: completing/failing one can spawn new ones.
import { v4 as uuid } from "uuid";

export function makeGoal(text, { weight = 60, spawnedTurn = 0 } = {}) {
  return {
    id: uuid(),
    text,
    status: "active",
    weight,
    spawnedTurn,
  };
}

// Seed initial goals from world-gen output.
export function seedGoals(texts, spawnedTurn = 0) {
  return (texts || []).map((t, i) =>
    makeGoal(t, { weight: 70 - i * 5, spawnedTurn })
  );
}

// Apply goal deltas from a turn: add new ones, update statuses.
export function applyGoalDeltas(goals, deltas, currentTurn) {
  const out = [...goals];

  for (const add of deltas?.add || []) {
    const text = typeof add === "string" ? add : add.text;
    if (!text) continue;
    const weight = typeof add === "object" && add.weight ? add.weight : 60;
    out.push(makeGoal(text, { weight, spawnedTurn: currentTurn }));
  }

  for (const upd of deltas?.update || []) {
    const g = out.find((x) => x.id === upd.id) || out.find((x) => x.text === upd.id);
    if (g && upd.status) g.status = upd.status;
  }

  return out;
}

export function activeGoals(goals) {
  return (goals || []).filter((g) => g.status === "active");
}

// Entities referenced by active goals (cheap heuristic: capitalized words).
export function goalEntities(goals) {
  const ents = new Set();
  for (const g of activeGoals(goals)) {
    const matches = g.text.match(/\b[A-Z][a-zA-Z]+\b/g) || [];
    matches.forEach((m) => ents.add(m));
  }
  return [...ents];
}
