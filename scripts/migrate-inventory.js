// scripts/migrate-inventory.js — one-off I2 migration (v0.3 §5A).
// Upgrades every story's items to the new ItemSchema shape and seeds each NPC's
// live `inventory` from its descriptive profile loadout (weapons + gear) where
// it has none yet. The player's items stay on `story.inventory` (the documented
// player alias). Idempotent — safe to run more than once.
//
//   node scripts/migrate-inventory.js
//
// (loadBundle also migrates lazily at runtime; this just does it eagerly for
//  every saved story without having to play each one.)
import "dotenv/config";
import { paths, readJSON, writeJSON, exists, listDirs } from "../src/storage.js";
import { makeItem, seedFromProfile } from "../src/inventory.js";

let stories = 0;
let upgradedItems = 0;
let seededNpcs = 0;

for (const storyId of listDirs(paths.stories())) {
  if (!exists(paths.storyFile(storyId))) continue;
  stories++;

  // 1. player items (story.inventory) → upgrade to full Items
  const story = readJSON(paths.storyFile(storyId));
  const before = JSON.stringify(story.inventory || []);
  story.inventory = (story.inventory || []).map(makeItem);
  if (JSON.stringify(story.inventory) !== before) upgradedItems += story.inventory.length;
  writeJSON(paths.storyFile(storyId), story);

  // 2. each NPC: seed inventory from profile if empty, else upgrade existing
  const charDir = paths.charactersDir(storyId);
  for (const id of story.npcIds || []) {
    const file = paths.npcFile(storyId, id);
    if (!exists(file)) continue;
    const npc = readJSON(file);
    if (!Array.isArray(npc.inventory)) npc.inventory = [];
    if (npc.inventory.length === 0) {
      const seeded = seedFromProfile(npc.profile);
      if (seeded.length) {
        npc.inventory = seeded;
        seededNpcs++;
      }
    } else {
      npc.inventory = npc.inventory.map(makeItem);
    }
    writeJSON(file, npc);
  }
  // also ensure the player character file has the field (harmless)
  if (exists(paths.playerFile(storyId))) {
    const player = readJSON(paths.playerFile(storyId));
    if (!Array.isArray(player.inventory)) {
      player.inventory = [];
      writeJSON(paths.playerFile(storyId), player);
    }
  }
}

console.log(
  `Inventory migration complete: ${stories} story/stories, ${upgradedItems} player item(s) upgraded, ${seededNpcs} NPC inventory/inventories seeded from profiles.`
);
