// inventory.js — per-character carried items (v0.3 §5A — I2).
// The player's live items stay on `story.inventory` (the documented player
// alias); every NPC holds its own `character.inventory`. These helpers give a
// uniform view + normalization, and seed/migrate from the descriptive profile.
import { v4 as uuid } from "uuid";

const KINDS = ["weapon", "armor", "tool", "consumable", "keepsake", "quest", "misc"];

// Normalize any raw item (string or partial object) into a full Item.
export function makeItem(raw) {
  if (typeof raw === "string") raw = { name: raw };
  raw = raw || {};
  return {
    id: raw.id || `item_${uuid().slice(0, 8)}`,
    name: raw.name || "item",
    desc: raw.desc || "",
    kind: KINDS.includes(raw.kind) ? raw.kind : "misc",
    equipped: !!raw.equipped,
    significance: raw.significance || "",
    concealed: !!raw.concealed,
    signature: !!raw.signature,
  };
}

// Seed a live inventory from the descriptive profile loadout (weapons + gear).
// Weapons become kind:"weapon" + signature; gear becomes kind:"misc".
export function seedFromProfile(profile) {
  const items = [];
  for (const w of profile?.weapons || [])
    items.push(makeItem({ name: w.name, desc: w.summary, kind: "weapon", signature: true }));
  for (const g of profile?.gear || [])
    items.push(makeItem({ name: g.name, desc: g.summary, kind: "misc" }));
  return items;
}

export function isPlayerRef(ref, story) {
  return ref === "player" || ref === (story.playerId || "player");
}

// The live inventory array for a character ref (player → story.inventory).
export function inventoryOf(ref, story, characters) {
  if (isPlayerRef(ref, story)) {
    if (!Array.isArray(story.inventory)) story.inventory = [];
    return story.inventory;
  }
  const c = characters.get(ref);
  if (!c) return null;
  if (!Array.isArray(c.inventory)) c.inventory = [];
  return c.inventory;
}

// Items others can perceive (not concealed) — for player-facing UI/context.
export function knownItems(inv) {
  return (inv || []).filter((i) => !i.concealed);
}

// Find an item in a list by id or (case-insensitive) name.
export function findItem(inv, ref) {
  return (inv || []).find(
    (i) => i.id === ref || i.name?.toLowerCase() === String(ref).toLowerCase()
  );
}

const KIND_GLYPH = {
  weapon: "⚔",
  armor: "🛡",
  tool: "🔧",
  consumable: "🧪",
  keepsake: "✦",
  quest: "❖",
  misc: "•",
};
export function kindGlyph(kind) {
  return KIND_GLYPH[kind] || "•";
}

// One-time normalization for a loaded bundle (lazy migration): upgrade legacy
// player items to full Items, and seed each NPC's inventory from its profile
// loadout if it has none yet (pre-I2 saves). Mutates in place.
export function migrateInventories({ story, npcs }) {
  story.inventory = (story.inventory || []).map(makeItem);
  for (const npc of npcs) {
    if (!Array.isArray(npc.inventory)) npc.inventory = [];
    if (npc.inventory.length === 0) {
      const seeded = seedFromProfile(npc.profile);
      if (seeded.length) npc.inventory = seeded;
    } else {
      npc.inventory = npc.inventory.map(makeItem);
    }
  }
}
