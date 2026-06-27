// worldGen.js — world + role + boundaries creation, and story opening.
import { v4 as uuid } from "uuid";
import { callGMStructured } from "./llm.js";
import { WorldGenSchema, OpeningSchema } from "./schemas.js";
import {
  paths,
  writeJSON,
  readJSON,
  scaffoldStory,
  appendTranscript,
} from "./storage.js";
import { loadPrompt, nowISO } from "./util.js";
import { defaultMentalStatus } from "./mentalStatus.js";
import { seedGoals } from "./goals.js";
import { makeItem, seedFromProfile } from "./inventory.js";

// Create a world from a premise (preset name or free-text idea).
export async function createWorld(premise) {
  const sys = loadPrompt("world_gen.md");
  const messages = [
    {
      role: "user",
      content: `Setting premise from the player: "${premise}"\n\nGenerate the world.`,
    },
  ];
  const gen = await callGMStructured(sys, messages, WorldGenSchema, 3000);

  const worldId = uuid();
  const world = {
    worldId,
    title: gen.title,
    genre: gen.genre,
    premise: gen.premise,
    tone: gen.tone,
    worldBible: gen.worldBible,
    background: gen.background || undefined, // v0.2 §6
    statSchema: gen.statSchema,
    roleSuggestions: gen.roleSuggestions || [],
    contentBoundaries: gen.contentBoundaries,
    createdAt: nowISO(),
  };

  writeJSON(paths.worldFile(worldId), world);
  writeJSON(paths.boundariesFile(worldId), gen.contentBoundaries);
  return world;
}

export function loadWorld(worldId) {
  return readJSON(paths.worldFile(worldId));
}

// Start a new story (playthrough) from a world + a chosen role.
export async function startStory(worldId, role, playerName) {
  const world = loadWorld(worldId);
  const sys = loadPrompt("opening.md");

  const context = `WORLD BIBLE
Title: ${world.title}
Genre: ${world.genre}
Premise: ${world.premise}
Tone: ${world.tone}
Stat schema: ${world.statSchema.join(", ")}
Content boundaries: ${JSON.stringify(world.contentBoundaries)}

${world.worldBible}

PLAYER ROLE: ${role}
${playerName ? `PLAYER WANTS THE NAME: ${playerName}` : ""}

Create the opening.`;

  const opening = await callGMStructured(
    sys,
    [{ role: "user", content: context }],
    OpeningSchema,
    3200
  );

  const storyId = uuid();
  scaffoldStory(storyId);

  // --- assign ids to all opening NPCs first, so knownCharacters can resolve (F11) ---
  const playerId = "player";
  const nameToId = {};
  const npcIds = [];
  for (const npc of opening.npcs || []) {
    const id = npc.id || `npc_${uuid().slice(0, 8)}`;
    nameToId[npc.name] = id;
    if (npc.displayName) nameToId[npc.displayName] = id;
    npcIds.push(id);
  }
  const resolveName = (ref) => {
    if (!ref) return null;
    if (String(ref).toLowerCase() === "player") return playerId;
    return nameToId[ref] || (npcIds.includes(ref) ? ref : null);
  };

  // --- player character (knows the opening cast by name, for narration clarity) ---
  const player = {
    id: playerId,
    name: opening.player.name,
    displayName: opening.player.name,
    aliases: [],
    role: opening.player.role || role,
    stats: opening.player.stats,
    mentalStatus: opening.player.mentalStatus || defaultMentalStatus(),
    visualDescriptor: opening.player.visualDescriptor || "",
    persona: opening.player.persona || "",
    canon: Array.isArray(opening.player.canon) ? opening.player.canon : [],
    profile: opening.player.profile || {},
    portraitPath: null,
    knownCharacters: [...npcIds], // F11 — player knows the opening cast
    isPlayer: true,
  };
  writeJSON(paths.playerFile(storyId), player);

  // --- NPCs: each knows the OTHER opening NPCs; knows the PLAYER only if the opening
  //     declares it (F11) — otherwise the player is a newcomer they address generically.
  for (const npc of opening.npcs || []) {
    const id = nameToId[npc.name];
    const explicit = (npc.knownCharacters || []).map(resolveName).filter(Boolean);
    const knownCharacters = [...new Set([...npcIds.filter((x) => x !== id), ...explicit])];
    writeJSON(paths.npcFile(storyId, id), {
      id,
      name: npc.name,
      displayName: npc.displayName || npc.name,
      aliases: [],
      role: npc.role || "",
      stats: npc.stats || {},
      mentalStatus: npc.mentalStatus || defaultMentalStatus(),
      relationshipToPlayer: npc.relationshipToPlayer ?? 0,
      visualDescriptor: npc.visualDescriptor || "",
      persona: npc.persona || "",
      canon: Array.isArray(npc.canon) ? npc.canon : [],
      profile: npc.profile || {},
      // v0.3 §5A — starting items from the opening, else seeded from the profile loadout.
      inventory:
        Array.isArray(npc.inventory) && npc.inventory.length
          ? npc.inventory.map(makeItem)
          : seedFromProfile(npc.profile),
      portraitPath: null,
      knownCharacters,
      isPlayer: false,
    });
  }

  const present = (opening.scene.present || []).map((n) => nameToId[n] || n);

  // --- goals ---
  const goals = seedGoals(opening.goals, 0);

  // --- first turn (turn 0: the opening) ---
  const targetBeats = Number(process.env.CHAPTER_TARGET_BEATS || 12);
  const openingTurn = {
    index: 0,
    chapter: 1,
    playerInput: "",
    narration: opening.narration,
    ask: opening.ask || "What do you do?",
    suggestedActions: opening.suggestedActions || [],
    at: nowISO(),
  };

  const story = {
    storyId,
    worldId,
    title: opening.title || `${player.name}'s Story`,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    playerId,
    npcIds,
    scene: {
      location: opening.scene.location,
      timeOfDay: opening.scene.timeOfDay || "day",
      present,
      summary: opening.scene.summary || "",
    },
    // v0.3 §5A — the player's live inventory (seeded from the opening loadout).
    inventory: [
      ...(opening.player.inventory || []).map(makeItem),
      ...(opening.player.inventory?.length ? [] : seedFromProfile(opening.player.profile)),
    ],
    goals,
    chapter: { index: 1, beatCount: 0, targetBeats, sceneImages: 0 },
    recentTurns: [openingTurn],
    turnCount: 0,
    encounter: null,
    activity: null,
  };

  writeJSON(paths.storyFile(storyId), story);
  appendTranscript(storyId, openingTurn);

  // seed empty memory store + world-state ledger
  writeJSON(paths.memoryFile(storyId), {
    storyId,
    items: [],
    background: [],
  });
  writeJSON(paths.ledgerFile(storyId), { storyId, facts: [] });

  return { story, player };
}
