// schemas.js — canonical data shapes (Technical Spec §5) + Claude output schema (§6.1).
// Used to validate AI structured output and API payloads.
import { z } from "zod";

// ---- World (§5.1) ----------------------------------------------------------
export const ContentBoundariesSchema = z.object({
  violence: z.string().default("moderate"),
  themes_blocked: z.array(z.string()).default([]),
  tone: z.string().default(""),
});

// Structured, player-visible world background (v0.2 §6).
export const WorldBackgroundSchema = z.object({
  overview: z.string().default(""),
  factions: z
    .array(z.object({ name: z.string(), summary: z.string().default("") }))
    .default([]),
  places: z
    .array(z.object({ name: z.string(), summary: z.string().default("") }))
    .default([]),
  history: z.string().default(""),
  rules: z.string().default(""),
});

export const WorldSchema = z.object({
  worldId: z.string(),
  title: z.string(),
  genre: z.string(),
  premise: z.string(),
  tone: z.string(),
  worldBible: z.string(),
  background: WorldBackgroundSchema.optional(), // v0.2 §6; absent on pre-v0.2 worlds
  statSchema: z.array(z.string()).min(1),
  roleSuggestions: z.array(z.string()).default([]),
  contentBoundaries: ContentBoundariesSchema,
  createdAt: z.string().optional(),
});

// ---- Carried item (v0.3 §5A — I2) ------------------------------------------
// A live per-character held item (weapons + things that matter), with a
// category + a few flags — not just the descriptive profile loadout.
export const ItemKindSchema = z.enum([
  "weapon",
  "armor",
  "tool",
  "consumable",
  "keepsake",
  "quest",
  "misc",
]);

export const ItemSchema = z.object({
  id: z.string().optional(), // assigned by makeItem() when stored; absent in model output
  name: z.string(),
  desc: z.string().default(""),
  kind: ItemKindSchema.default("misc"),
  equipped: z.boolean().default(false),
  significance: z.string().default(""), // why it matters (sentimental/quest)
  concealed: z.boolean().default(false), // hidden — never leaked to the player until revealed
  signature: z.boolean().default(false), // a defining item (e.g. the spy's silver dagger)
});

// ---- Mental status (§5.3, §6A.3) ------------------------------------------
export const MentalStatusSchema = z.object({
  state: z.string().default("calm"),
  dimensions: z
    .object({
      Stress: z.coerce.number().default(20),
      Morale: z.coerce.number().default(60),
      Trust: z.coerce.number().default(50),
      Composure: z.coerce.number().default(70),
    })
    .default({}),
  notes: z.string().default(""),
});

// ---- Structured character profile (v0.3 §5) -------------------------------
// A power has exactly two hooks (v0.3 §5.3.5): a linked `stat` resolved via the
// ordinary skillCheck, and a `cost` expressed as a signed mental-status delta
// applied through deltas.mentalStatus. No uses/cooldown/DC/bonus fields.
export const PowerSchema = z.object({
  name: z.string(),
  summary: z.string().default(""),
  stat: z.string().default(""), // one of the world's statSchema entries
  cost: z.record(z.string(), z.coerce.number()).default({}), // mental-status delta on use
});

export const GearSchema = z.object({
  name: z.string(),
  summary: z.string().default(""),
});

export const FactionRefSchema = z.object({
  name: z.string().default(""),
  rank: z.string().default(""),
  standing: z.string().default(""),
});

export const CharacterProfileSchema = z.object({
  occupation: z.string().default(""),
  faction: FactionRefSchema.default({}),
  personality: z.array(z.string()).default([]),
  characteristics: z.array(z.string()).default([]),
  powers: z.array(PowerSchema).default([]),
  weapons: z.array(GearSchema).default([]),
  gear: z.array(GearSchema).default([]),
  background: z.string().default(""),
  motivations: z.array(z.string()).default([]),
  speechStyle: z.string().default(""),
});

// ---- Character (§5.3) ------------------------------------------------------
export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().default(""),
  stats: z.record(z.string(), z.coerce.number()).default({}),
  mentalStatus: MentalStatusSchema.default({}),
  relationshipToPlayer: z.number().min(-100).max(100).optional(), // NPCs only
  visualDescriptor: z.string().default(""), // for image-prompt consistency
  persona: z.string().default(""), // stable bio / voice note
  canon: z.array(z.string()).default([]), // append-only established facts (never contradict)
  profile: CharacterProfileSchema.default({}), // v0.3 §5 — structured profile
  // v0.3 §5A (I2) — live carried items. The player character's live items are
  // kept on `story.inventory` (the documented player alias); NPCs use this.
  inventory: z.array(ItemSchema).default([]),
  // v0.2 §3 (dedupe) + §7 (portraits)
  displayName: z.string().default(""), // shown in UI; defaults to name; used for disambiguation
  aliases: z.array(z.string()).default([]), // other names the GM has used for this character
  portraitPath: z.string().nullable().default(null), // rel path once rendered; null = placeholder
  // F11: ids of characters this character knows BY NAME/identity (the acquaintance graph).
  // Gates how they address others; the player is a node too ("player" present = knows your name).
  knownCharacters: z.array(z.string()).default([]),
  isPlayer: z.boolean().default(false),
});

// ---- Memory item (§5.4) ----------------------------------------------------
export const MemoryTypeSchema = z.enum([
  "event",
  "fact",
  "relationship",
  "promise",
  "location",
  "item",
  "mental",
]);

export const MemorySchema = z.object({
  id: z.string(),
  storyId: z.string(),
  type: MemoryTypeSchema,
  text: z.string(),
  entities: z.array(z.string()).default([]),
  // Who knows this fact: character ids (+ the sentinel "player"). The GM is
  // omniscient over all memory, but an NPC may only act on memories they witness.
  witnesses: z.array(z.string()).default([]),
  weight: z.number().min(0).max(100).default(50),
  createdTurn: z.number().default(0),
  lastReferencedTurn: z.number().default(0),
  links: z.array(z.string()).default([]),
});

// ---- Goal / quest (§5.5) ---------------------------------------------------
export const GoalStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "abandoned",
]);

export const GoalSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: GoalStatusSchema.default("active"),
  weight: z.number().min(0).max(100).default(50),
  spawnedTurn: z.number().default(0),
});

// ---- World-state ledger fact (v0.2 §4.4) ----------------------------------
export const LedgerKindSchema = z.enum([
  "possession",
  "check_outcome",
  "location",
  "promise",
  "death",
  "block",
  "fact",
]);

export const LedgerFactSchema = z.object({
  id: z.string(),
  kind: LedgerKindSchema.default("fact"),
  text: z.string(),
  entities: z.array(z.string()).default([]),
  durable: z.boolean().default(false), // true = never decays, always in context
  status: z.enum(["active", "superseded"]).default("active"),
  createdTurn: z.number().default(0),
  chapter: z.number().default(1),
});

// ---- Encounter (combat/action) state (v0.2 §10.3) -------------------------
export const ConditionSchema = z.enum([
  "unharmed",
  "hurt",
  "badly hurt",
  "down",
]);

export const EncounterSchema = z.object({
  active: z.boolean().default(true),
  kind: z.enum(["combat", "chase", "standoff"]).default("combat"),
  round: z.number().default(1),
  participants: z
    .array(
      z.object({ id: z.string(), condition: ConditionSchema.default("unharmed") })
    )
    .default([]),
  playerCondition: ConditionSchema.default("unharmed"),
  stakes: z.string().default(""),
});

// ---- Activity (cooperative/social/daily) state (v0.2 §10A.5) --------------
export const ActivityKindSchema = z.enum([
  "meal",
  "drinks",
  "game",
  "music",
  "craft",
  "work",
  "rest",
  "romance",
  "other",
]);

export const ActivitySchema = z.object({
  active: z.boolean().default(true),
  kind: ActivityKindSchema.default("other"),
  participants: z.array(z.string()).default([]),
  beat: z.number().default(1),
  summary: z.string().default(""),
});

// ---- Scene/action image attached to a turn (v0.2 §9) ----------------------
export const SceneImageSchema = z.object({
  path: z.string().nullable().default(null),
  kind: z.string().default("scene"), // action | scene | portrait_moment
  priority: z.coerce.number().default(50),
  prompt: z.string().default(""),
});

// ---- Scene / inventory -----------------------------------------------------
export const SceneSchema = z.object({
  location: z.string().default("Unknown"),
  timeOfDay: z.string().default("day"),
  present: z.array(z.string()).default([]), // npc ids
  summary: z.string().default(""),
});

export const InventoryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string().default(""),
});

// ---- Turn (transcript entry) ----------------------------------------------
export const TurnSchema = z.object({
  index: z.number(),
  chapter: z.number(),
  playerInput: z.string().default(""),
  narration: z.string().default(""),
  ask: z.string().default(""),
  suggestedActions: z.array(z.string()).default([]),
  diceResult: z.any().optional(),
  sceneImage: SceneImageSchema.nullable().optional(), // v0.2 §9
  at: z.string(),
});

// ---- Story state (§5.2) ----------------------------------------------------
export const StorySchema = z.object({
  storyId: z.string(),
  worldId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  playerId: z.string().default("player"),
  npcIds: z.array(z.string()).default([]),
  scene: SceneSchema.default({}),
  // The player character's live inventory (v0.3 §5A keeps this as the player
  // alias; NPCs hold their own `character.inventory`).
  inventory: z.array(ItemSchema).default([]),
  goals: z.array(GoalSchema).default([]),
  chapter: z
    .object({
      index: z.number().default(1),
      beatCount: z.number().default(0),
      targetBeats: z.number().default(12),
    })
    .default({}),
  recentTurns: z.array(TurnSchema).default([]),
  turnCount: z.number().default(0),
  encounter: EncounterSchema.nullable().default(null), // v0.2 §10
  activity: ActivitySchema.nullable().default(null), // v0.2 §10A
});

// ---- Chapter record (§5.6) -------------------------------------------------
export const ChapterSchema = z.object({
  storyId: z.string(),
  index: z.number(),
  title: z.string(),
  recap: z.string(),
  turningPoint: z.string().default(""),
  narrativeTurns: z.array(TurnSchema).default([]),
  imagePrompt: z.string().default(""),
  imagePath: z.string().nullable().default(null),
  startTurn: z.number(),
  endTurn: z.number(),
});

// ---- Claude structured output (§6.1) --------------------------------------
// Deltas Claude emits each turn so the backend can update state deterministically.
export const DeltaNpcSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  displayName: z.string().default(""), // disambiguator for genuine same-name collisions
  role: z.string().default(""),
  stats: z.record(z.string(), z.coerce.number()).default({}),
  mentalStatus: MentalStatusSchema.default({}),
  relationshipToPlayer: z.coerce.number().default(0),
  visualDescriptor: z.string().default(""),
  persona: z.string().default(""),
  canon: z.array(z.string()).default([]),
  profile: CharacterProfileSchema.default({}), // v0.3 §5
  inventory: z.array(ItemSchema).default([]), // v0.3 §5A — starting items for a new NPC
  knownCharacters: z.array(z.string()).default([]), // F11 — who this NPC already knows by name
});

export const DeltasSchema = z.object({
  mentalStatus: z
    .record(z.string(), z.record(z.string(), z.coerce.number()))
    .default({}),
  relationships: z.record(z.string(), z.coerce.number()).default({}),
  // v0.3 §5A — per-character inventory. Accepts EITHER the legacy player form
  // `{ add, remove }` OR a per-character map `{ "<charRef>": { add, remove } }`.
  // Kept permissive (z.any) and normalized in stateExtractor.applyDeltas.
  inventory: z.any().default({}),
  // v0.3 §5A — relocate an item between characters (give / loot / steal).
  transfer: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        item: z.string(), // item id or name
      })
    )
    .default([]),
  scene: SceneSchema.partial().default({}),
  newNpcs: z.array(DeltaNpcSchema).default([]),
  goals: z
    .object({
      add: z.array(z.union([z.string(), GoalSchema.partial()])).default([]),
      update: z
        .array(z.object({ id: z.string(), status: GoalStatusSchema }))
        .default([]),
    })
    .default({}),
  newMemories: z
    .array(
      z.object({
        type: MemoryTypeSchema.default("event"),
        text: z.string(),
        weight: z.coerce.number().default(50),
        entities: z.array(z.string()).default([]),
        // character ids (+ "player") who witnessed/know this; defaults to the
        // present cast if the GM omits it.
        witnesses: z.array(z.string()).default([]),
      })
    )
    .default([]),
  referencedMemories: z.array(z.string()).default([]), // memory ids referenced
  // New durable facts to append to a character's canon, keyed by character id.
  canonFacts: z.record(z.string(), z.array(z.string())).default({}),
  // v0.3 §5 — refine/extend a character's structured profile (field-wise merge),
  // keyed by character id or name. Partial: only the fields that change.
  profileUpdate: z.record(z.string(), z.any()).default({}),
  // F11 — characters who learned each other's names this turn. Each inner group is a set
  // of refs (ids/names, "player" allowed) who now all know each other (mutual). Emit when
  // an introduction happens in fiction (someone gives/shares a name).
  introductions: z.array(z.array(z.string())).default([]),
  // v0.2 §4 — world-state ledger updates.
  worldState: z
    .object({
      add: z
        .array(
          z.object({
            kind: LedgerKindSchema.default("fact"),
            text: z.string(),
            entities: z.array(z.string()).default([]),
            durable: z.boolean().default(false),
          })
        )
        .default([]),
      resolve: z.array(z.string()).default([]), // ledger fact ids or matching text
    })
    .default({}),
  // v0.2 §9 — GM signals an illustratable moment.
  illustrate: z
    .object({
      should: z.boolean().default(false),
      kind: z.enum(["action", "scene", "portrait_moment", "none"]).default("none"),
      prompt: z.string().default(""),
      priority: z.coerce.number().default(50),
    })
    .default({}),
  // v0.2 §10 — combat/action encounter lifecycle.
  encounter: z
    .object({
      start: z
        .object({
          kind: z.enum(["combat", "chase", "standoff"]).default("combat"),
          participants: z.array(z.string()).default([]),
          stakes: z.string().default(""),
        })
        .optional(),
      round: z.record(z.string(), ConditionSchema).optional(), // id (or "player") -> condition
      end: z
        .object({ outcome: z.string().default(""), summary: z.string().default("") })
        .optional(),
    })
    .default({}),
  // v0.2 §10A — cooperative/social/daily activity lifecycle.
  activity: z
    .object({
      start: z
        .object({
          kind: ActivityKindSchema.default("other"),
          participants: z.array(z.string()).default([]),
          summary: z.string().default(""),
        })
        .optional(),
      beat: z.object({ summary: z.string().default("") }).optional(),
      end: z
        .object({ outcome: z.string().default(""), summary: z.string().default("") })
        .optional(),
    })
    .default({}),
  chapterShouldEnd: z.boolean().default(false),
  needsPlayerInput: z.boolean().default(true),
});

export const GMResponseSchema = z.object({
  narration: z.string(),
  ask: z.string().default("What do you do?"),
  suggestedActions: z.array(z.string()).default([]),
  deltas: DeltasSchema.default({}),
});

// World generation output (worldGen.js).
export const WorldGenSchema = z.object({
  title: z.string(),
  genre: z.string(),
  premise: z.string(),
  tone: z.string(),
  worldBible: z.string(),
  background: WorldBackgroundSchema.default({}), // v0.2 §6
  statSchema: z.array(z.string()).min(3),
  roleSuggestions: z.array(z.string()).default([]),
  contentBoundaries: ContentBoundariesSchema,
});

// Story opening output (worldGen.js — startStory).
export const OpeningSchema = z.object({
  title: z.string(),
  player: z.object({
    name: z.string(),
    role: z.string(),
    stats: z.record(z.string(), z.coerce.number()),
    mentalStatus: MentalStatusSchema.default({}),
    visualDescriptor: z.string().default(""),
    persona: z.string().default(""),
    canon: z.array(z.string()).default([]),
    profile: CharacterProfileSchema.default({}),
    inventory: z.array(ItemSchema).default([]), // v0.3 §5A — starting items
  }),
  npcs: z.array(DeltaNpcSchema).default([]),
  scene: SceneSchema,
  goals: z.array(z.string()).default([]),
  narration: z.string(),
  ask: z.string().default("What do you do?"),
  suggestedActions: z.array(z.string()).default([]),
});

// Chapter recap output (chapters.js).
export const RecapSchema = z.object({
  title: z.string(),
  recap: z.string(),
  turningPoint: z.string().default(""),
  imagePrompt: z.string(),
});
