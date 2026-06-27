# OpenWorld — Enhancements Specification (v0.2)

**Bug fixes + image experience + combat + resilience, layered on the v0.1 MVP.**

| | |
|---|---|
| **Document type** | Enhancement / Delta Specification |
| **Companion to** | `OpenWorld_Product_Spec.md`, `OpenWorld_Technical_Spec_MVP.md`, `EVALUATION_AND_FIXES.md` |
| **Version** | 0.2 (Draft) |
| **Owner** | Ning |
| **Last updated** | 2026-06-22 |
| **Status** | Draft for review |

---

## 1. Scope

This spec defines the **next slice of work** on top of the shipped local MVP. It is a *delta*: it
references the existing v0.1 data models, files, and turn pipeline rather than restating them, and
assumes the P0–P2 fixes recorded in `EVALUATION_AND_FIXES.md` §6 are in place (they introduce
`character.persona`, `character.canon`, `memory.witnesses`, and memory linking — several items below
build directly on those).

It covers three things the user asked for:

- **Two more bugs** (continuing the `issues.txt` numbering): #5 duplicate character names, #6 lost
  cross‑chapter facts (the "I failed to take the weapon in Ch.1 but had it in Ch.2" case).
- **One new feature**: expandable / full‑size images.
- **A set of improvements**: richer world background, per‑character portraits, portrait‑anchored and
  scene‑level image generation with action/fight prioritization, lightweight combat/action scenes,
  and automatic retry when a Claude call fails for credit/rate‑limit reasons.

### Requirement → section map

| # | Requirement (verbatim intent) | Section |
|---|---|---|
| Bug 5 | Duplicate name of character | §3 (A1) |
| Bug 6 | Story ignores previous chapters / loses base facts (failed‑weapon example) | §4 (A2) |
| Feat 1 | Allow expanding images to see the full picture | §5 (B1) |
| Imp | Add background description about the world | §6 (B2) |
| Imp | Portrait for each character | §7 (C1) |
| Imp | Use portraits to generate consistent chapter images | §8 (C2) |
| Imp | Images can also picture the scene | §9 (C3) |
| Imp | Action/fight scenes prioritized as images | §9 (C3) |
| Imp | Some action/fighting scenes (mechanics) | §10 (D1) |
| Imp | More physical / non‑conversational interaction (romance, drinking, daily life) | §10A (D2) |
| Imp | Resend the response after enough credit for the API call | §11 (E1) |

### Out of scope (unchanged from MVP)

Multiplayer/accounts/cloud, a real combat *simulator* (we stay story‑first per Product Spec §2.3),
and any paid image tier. All new image work continues through the existing pluggable adapter
(`src/images.js`) and remains optional.

---

## 2. Design principles for this slice

1. **State is authoritative; narration serves state.** When prose and structured state disagree, the
   structured state (inventory, world‑state ledger, character canon) wins, and the GM is told so.
   This is the spine of the bug fixes.
2. **Images never block a turn.** All new image generation (portraits, scene/action images) runs off
   the turn's critical path; the UI shows placeholders and backfills — extending the existing
   on‑demand render pattern in `server.js`.
3. **Cost stays bounded and opt‑in.** Image and combat features degrade gracefully to text +
   placeholders when `IMAGE_PROVIDER=none` or budgets are hit.
4. **Provider‑agnostic visuals.** Visual consistency is anchored on a stored text *visual descriptor*
   first (works with every provider, incl. keyless Pollinations); true reference‑image conditioning
   is a best‑effort enhancement only where the provider supports it.

---

# Part A — Bug fixes

## 3. A1 — Duplicate character names (issue #5)

### 3.1 Problem
Two distinct characters can end up sharing a name, which then makes name→id resolution ambiguous and
corrupts relationships, mental status, and scene presence.

### 3.2 Root cause (code‑level)
- NPCs are keyed by generated id, but the GM refers to characters **by name** in deltas
  (`scene.present`, `mentalStatus`, `relationships`). Resolution goes through a single
  `nameToId[name.toLowerCase()]` map in `src/stateExtractor.js` and `src/worldGen.js`.
- `applyDeltas` only checks `characters.has(npc.id)` before minting a new id. A `newNpcs` entry with
  an **existing name but no/!matching id** creates a *second* character and **overwrites**
  `nameToId[name]`, so the old character becomes unreachable by name and two files share a name.
- Nothing instructs or constrains the GM to avoid reusing a name, and nothing merges an
  accidentally re‑introduced character back into the original.

### 3.3 Design
Introduce a **canonical character registry** with unique, case‑insensitive display names per story.

1. **Dedupe on creation.** In `applyDeltas`, before creating a `newNpc`, look up the name in the
   registry (case‑ and whitespace‑normalized). If it matches an existing character:
   - Treat it as a **reference to the existing character**, not a new one. Merge any new fields
     (fill empty `role`/`stats`/`visualDescriptor`/`persona`; never silently overwrite established
     canon).
   - Do **not** allocate a new id or file.
2. **Disambiguate genuine collisions.** If the GM truly intends a *different* person with the same
   name (e.g. two guards named "Roel"), the GM must supply a distinguishing `displayName` (e.g.
   "Roel the Younger"). If it doesn't and the personas clearly differ, the engine appends a
   disambiguator (`Roel (2)`) and logs a warning. Default assumption is **same person**.
3. **Prompt guard.** `system_gm.md` gains: *"Each character has a unique name. Before introducing a
   new NPC, check the characters already in context — if the person already exists, reference them by
   their existing name/id; do not create a duplicate. Only introduce a new NPC for a genuinely new
   person, and give them a name not already in use."*
4. **Resolution hardening.** `resolveRef` prefers exact id, then normalized‑name exact match, and
   returns `null` (ignored) rather than a wrong guess when ambiguous — so a bad reference can never
   silently mutate the wrong character.

### 3.4 Data model delta
`CharacterSchema` (`src/schemas.js`) gains:
```jsonc
"displayName": "string",   // optional; defaults to name. Shown in UI; used for disambiguation.
"aliases": ["string"]      // other names the GM has used for this character (for resolution)
```
A small helper `normalizeName(s)` (lowercase, trim, collapse spaces) backs the registry.

### 3.5 Acceptance criteria
- Re‑introducing an existing NPC by name never creates a second character file.
- After 30+ turns introducing recurring NPCs, `data/stories/<id>/characters/` contains no two files
  with the same normalized name.
- Relationship/mental deltas addressed by name always land on the intended single character.

---

## 4. A2 — Lost cross‑chapter facts & inventory drift (issue #6)

> *"I tried to get a weapon in chapter 1 but failed the dice check. In chapter 2 I suddenly had it,
> back in my room, with no reason."*

### 4.1 Problem
The story contradicts an established outcome from a previous chapter. A **failed/negative** result
(you did **not** get the weapon) is not durably recorded, so once it scrolls out of the 8‑turn
`recentTurns` window the GM forgets it and later narrates the player owning the item.

### 4.2 Root cause (code‑level)
- Inventory *is* persisted across chapters in `story.json` and *is* shown to the GM
  (`contextBuilder.js` `invBlock`). So the bug is **not** that inventory resets.
- The bug is two‑fold:
  1. **No record of negative/consequential outcomes.** Dice results are shown in the UI and fed to
     the GM for the *current* turn only; they are never written as memories or world‑state. "The
     attempt to steal the blade failed; the blade remains in the armory" is captured nowhere.
  2. **Inventory is not treated as authoritative.** Nothing forbids the GM from narrating the player
     using/owning an item that isn't in the INVENTORY block, and nothing requires that *gaining* an
     item go through `deltas.inventory.add` with an in‑world cause. So the model can hallucinate
     possession.
- Chapter recaps roll *prose* forward but do not re‑assert hard facts (who has what, what failed,
  what's locked) into per‑turn context.

### 4.3 Design — a persistent **World‑State Ledger** + inventory authority

1. **World‑State Ledger** — a new per‑story store of durable, structured facts that outlive the
   recent‑turns window and are **always** injected into context (not subject to weighted‑memory
   decay). It holds the "base facts" the story must respect:
   - possessions & their provenance, locked/blocked things, established locations, standing
     promises/debts, deaths, and **outcomes of consequential checks** (esp. failures).
   - Stored at `data/stories/<storyId>/state/ledger.json`.
2. **Record check outcomes automatically.** After `dice.js` resolves a check, the orchestrator writes
   a ledger fact regardless of the narration, e.g.
   `{ kind: "check_outcome", text: "Attempted to take the officer's blade — FAILED. Blade not acquired.", turn, chapter, entities: ["blade"] }`.
   Consequential failures (combat, theft, persuasion that gates an item/goal) are flagged
   `durable: true` so they never decay.
3. **Inventory is authoritative; gaining requires a cause.** `system_gm.md` gains:
   *"The INVENTORY and WORLD STATE blocks are ground truth. The player possesses exactly the listed
   items — nothing more. Never narrate the player owning, wearing, or using an item not in INVENTORY.
   To grant an item you MUST emit `deltas.inventory.add` with an in‑world reason in the narration, and
   that reason must not contradict the WORLD STATE ledger (e.g. do not grant an item a prior check
   established the player failed to obtain)."*
4. **Ledger in context.** `contextBuilder.js` adds a `# WORLD STATE (authoritative — never
   contradict)` block, placed above long‑term memory, listing active ledger facts (durable ones
   always; others by recency/relevance, capped).
5. **Ledger updates via deltas.** Extend the delta contract with `deltas.worldState.add` /
   `.resolve` (mark a fact resolved/obsolete, e.g. the player *later* legitimately buys the blade →
   the failure fact is marked superseded, inventory adds the item). This keeps the ledger from
   ossifying.
6. **Chapter close reasserts the ledger.** `chapters.js` recap continues as today, but chapter
   close also snapshots the open durable ledger facts into the chapter record so the "story so far"
   and ebook stay consistent.

### 4.4 Data model delta
New `LedgerFactSchema` (`src/schemas.js`):
```jsonc
{
  "id": "uuid",
  "kind": "possession | check_outcome | location | promise | death | block | fact",
  "text": "Human-readable fact the GM must respect.",
  "entities": ["blade", "player"],
  "durable": true,             // true = never decays, always in context
  "status": "active | superseded",
  "createdTurn": 14,
  "chapter": 1
}
```
New delta keys on `DeltasSchema`:
```jsonc
"worldState": {
  "add":     [ { "kind": "...", "text": "...", "entities": ["..."], "durable": true } ],
  "resolve": [ "<ledgerFactId or matching text>" ]
}
```

### 4.5 Acceptance criteria
- A failed acquisition check writes a `check_outcome` ledger fact that is present in context in a
  later chapter.
- With the inventory empty of a weapon, the GM cannot narrate the player wielding that weapon; any
  acquisition appears as an `inventory.add` with a stated cause.
- Scripted regression: fail to take item X in Ch.1 → by Ch.2 the player still does not have X unless
  a later turn explicitly grants it.

---

# Part B — Images & world presentation

## 5. B1 — Expandable / full‑size images (feature 1)

### 5.1 Goal
Let the player click any generated illustration (chapter card in the feed, gallery thumbnail, and —
once added — portraits and scene images) to view it full size.

### 5.2 Design (client‑only)
- Add a lightweight **lightbox** to `public/`: clicking an image opens a centered overlay showing the
  full‑resolution image with a caption (chapter title / scene label), a close affordance (✕, click
  backdrop, or `Esc`), and ←/→ to page through the chapter gallery.
- Images are already served full‑res by `GET /api/story/:id/image/:n`; the lightbox simply loads that
  URL (the thumbnails are CSS‑downscaled). No backend change required for chapter images.
- Implement with a single delegated click handler in `public/app.js` and a `.lightbox` block in
  `public/styles.css`; no dependencies, consistent with the "no build step" constraint.
- Accessibility: trap focus while open, restore on close, `role="dialog"`, `alt` text from the
  caption.

### 5.3 Acceptance criteria
- Clicking a chapter image or gallery thumb opens a full‑size overlay; `Esc`/backdrop/✕ closes it.
- Arrow keys move between chapter images. Works for portraits and scene images once those exist.

---

## 6. B2 — Richer world background description (improvement)

### 6.1 Goal
Give the world a fuller, **player‑visible** background, and make that background reliably ground the
GM so the world stays coherent.

### 6.2 Design
1. **Structured world background.** Extend world generation (`prompts/world_gen.md`,
   `WorldGenSchema`) to emit, alongside the existing prose `worldBible`, a light structured
   background:
   ```jsonc
   "background": {
     "overview": "2–3 sentence elevator pitch of the world.",
     "factions": [ { "name": "...", "summary": "..." } ],
     "places":   [ { "name": "...", "summary": "..." } ],
     "history":  "Short timeline / what led to now.",
     "rules":    "What is true here (magic/tech/social rules the GM must honor)."
   }
   ```
   The prose `worldBible` stays as the canonical free‑text; `background` is a structured view of it
   for display and for tighter context grounding.
2. **Player‑facing "World" panel.** Add a **World** entry to the right rail (collapsible, like the
   gallery) and a brief world intro card shown at story start, rendering `background.overview`,
   factions, and places. This directly satisfies "adding background description about the world" for
   the player.
3. **Context grounding.** `contextBuilder.buildSystemPrompt` already injects `worldBible`; also inject
   the structured `background` (compactly) so factions/places/rules are explicitly enumerated for the
   GM, reducing world contradictions.
4. **Backward compatibility.** Worlds created before v0.2 have no `background`; the UI/context fall
   back to `worldBible` prose. World‑gen for new worlds populates both.

### 6.3 API delta
- `GET /api/world/:worldId` already returns the full world; include `background`.
- No new route required (the world panel reads the world object the client already has).

### 6.4 Acceptance criteria
- New worlds expose `background` with ≥1 faction and ≥1 place; the World panel renders them.
- Pre‑v0.2 worlds still load and display (prose fallback) without error.

---

# Part C — Character portraits & image generation

## 7. C1 — Character portraits (improvement)

### 7.1 Goal
A portrait image for each major character (player + named NPCs), shown in the UI and reused to keep
later illustrations visually consistent.

### 7.2 Design
1. **Visual canon per character.** Reuse the existing `character.visualDescriptor`. At character
   creation (`worldGen.startStory` for player/opening NPCs; `stateExtractor` for `newNpcs`),
   enqueue a **portrait render** built from `visualDescriptor` + world art‑style hint.
2. **Async, pluggable, cached.** Portraits render through `src/images.js` (same providers). Rendering
   is **off the critical path**: the character is created immediately with `portraitPath: null`; a
   background job (or on‑demand route, mirroring `GET /image/:n`) fills it in. With
   `IMAGE_PROVIDER=none`, the portrait is an SVG placeholder built from initials + descriptor
   (extend `src/placeholder.js`).
3. **Storage.** `data/stories/<storyId>/characters/<id>.png` (next to the existing `<id>.json`), with
   `portraitPath` recorded on the character. Helper `paths.portrait(storyId, id)` /
   `paths.portraitRel(...)` added to `src/storage.js`.
4. **API.** `GET /api/story/:storyId/portrait/:characterId` — serves the portrait, rendering on demand
   if a provider is enabled and the file is missing (reuse the dedupe + content‑sniff logic already in
   `server.js`), else returns the placeholder (never cached).
5. **UI.** Show the portrait in the character sheet (player), the **People** panel (NPCs), and the
   mental‑status blocks; clicking opens the §5 lightbox.

### 7.3 Data model delta
`CharacterSchema` gains:
```jsonc
"portraitPath": "stories/<storyId>/characters/<id>.png",  // null until rendered
"visualDescriptor": "…"   // already exists; now also required for portraits
```

### 7.4 Acceptance criteria
- Each named character has a portrait (or a deterministic placeholder) visible in the UI within a few
  seconds of appearing.
- Portraits persist and reload on resume; clicking opens the lightbox.

---

## 8. C2 — Portrait‑anchored consistent chapter images (improvement)

### 8.1 Goal
Chapter (and scene) illustrations should depict the *same* characters consistently across the story.

### 8.2 Design
1. **Descriptor‑first consistency (all providers).** The image‑prompt builder composes from the
   stable `visualDescriptor` of every character depicted, so e.g. "Sera — lean, ash‑streaked
   leathers, silver braid" appears identically in every prompt. This already half‑exists for the
   player in `chapter_recap.md`; generalize it to **all present characters** and centralize it in a
   new helper `src/imagePrompt.js` (`composeImagePrompt({ world, characters, moment })`).
2. **Reference‑image conditioning (best‑effort).** Where the provider supports image‑to‑image /
   reference input, pass the relevant character **portraits** as references to lock appearance:
   - `cloudflare` / `huggingface` / `gemini`: pass portrait(s) as conditioning where the model/endpoint
     allows (e.g. img2img or multi‑image prompt).
   - `pollinations` (keyless, text‑only): descriptor‑only — no reference image. This is the documented
     fallback; consistency relies on the descriptor.
   The adapter signature becomes `renderImage(prompt, outPath, { referenceImages?: string[] })`; each
   provider uses references if it can, ignores them otherwise.
3. **Chapter close uses it.** `chapters.closeChapter` builds the image prompt via
   `composeImagePrompt` with the characters featured in the chapter's turning point and passes their
   portrait paths as references.

### 8.3 Acceptance criteria
- A chapter image prompt for a scene featuring N known characters includes each one's descriptor.
- With a reference‑capable provider configured, chapter images visibly track portraits; with
  Pollinations, descriptors are consistent across chapters.

---

## 9. C3 — Scene images + action/fight prioritization (improvement)

### 9.1 Goal
Illustrate notable *in‑chapter* moments (not just chapter ends), and **prioritize action/fight
scenes** for illustration. ("Images can also picture the scene" + "Action/fight scenes prioritized as
images.")

### 9.2 Design
1. **GM signals illustratable moments.** Extend the delta contract:
   ```jsonc
   "illustrate": {
     "should": true,
     "kind": "action | scene | portrait_moment | none",
     "prompt": "concrete visual description of THIS moment",
     "priority": 90              // 0–100; combat/action should be high
   }
   ```
   The GM sets `kind:"action"` with high priority during fights/chases/dramatic feats.
2. **Prioritized, budgeted rendering.** The orchestrator enqueues scene renders **off the turn path**
   through a small queue with a per‑chapter budget (`SCENE_IMAGE_BUDGET`, default e.g. 3) and a
   priority sort: `action` is always rendered (subject to budget), `scene` is rendered only if budget
   remains. This honors "action/fight prioritized" while bounding cost.
3. **Storage & serving.** Scene images live at
   `data/stories/<storyId>/scenes/<turnIndex>.png`; served by
   `GET /api/story/:storyId/scene/:turnIndex` (same on‑demand/placeholder/sniff pattern). The turn
   record gains `sceneImage: { path, kind, priority, prompt }` so the feed and ebook can show them.
4. **UI.** When a turn has a scene image, the feed renders it inline beneath the narration (lazy‑
   loaded, click → lightbox). Action images get a subtle "⚔" affordance.
5. **Config.** `.env`: `SCENE_IMAGES=off|auto` (default `auto` when a provider is set, `off` when
   `IMAGE_PROVIDER=none`), `SCENE_IMAGE_BUDGET=3`.
6. **Consistency.** Scene/action prompts go through the same `composeImagePrompt` (descriptors +
   portrait references) from §8.

### 9.3 Acceptance criteria
- A fight turn produces an inline action illustration (provider on) or is skipped cleanly (provider
  off / budget hit) without delaying the narration response.
- Scene images respect the per‑chapter budget and action‑first priority.
- Scene images appear in the ebook export for the chapters they belong to.

---

# Part D — Non‑conversational interactions

## 10. D1 — Lightweight action/fight scenes (improvement)

### 10.1 Goal
Give fights real mechanical tension using the systems already present (stats, d20, mental status),
while staying **story‑first** (Product Spec §2.3 — not a combat simulator).

### 10.2 Design — "Encounter mode"
1. **Entering an encounter.** When narration turns to a fight/chase/standoff, the GM sets
   `deltas.encounter.start = { kind: "combat|chase|standoff", participants: ["<id>"...], stakes: "…" }`.
   The orchestrator opens an `encounter` block on the story.
2. **Round resolution via existing dice.** Each combat turn is one or more **contested checks** built
   on `dice.js`: attacker `stat` vs. a DC derived from the defender's opposing stat (e.g.
   `DC = 10 + statModifier(defender, opposingStat) + mentalStatusModifier(defender)`). Outcome tiers
   already map cleanly: critical success → decisive blow; partial → trade hits; failure → you're hit;
   etc. **Mental status feeds in both directions** (fear lowers Composure‑based attack/defense; a hit
   raises Stress / lowers Composure via `mentalStatus` deltas — closing Product Spec §6A.3's "events
   push mental status").
3. **A simple condition track, not HP bars.** Track a lightweight **Condition** per participant
   (`unharmed → hurt → badly hurt → down/out`) advanced by check outcomes, rather than numeric HP, to
   keep it story‑shaped. Stored on the encounter; surfaced in the UI as a small status line, not a
   spreadsheet.
4. **Player agency preserved.** The "ask the player" rule still holds every round — the GM narrates
   the exchange and asks what the player does next (press the attack, disengage, parley, use an
   item). No auto‑resolution of the player's choices.
5. **Ending.** The GM sets `deltas.encounter.end = { outcome: "…", summary: "…" }`; the orchestrator
   writes a durable **ledger fact** (§4) for the result (who won, injuries, deaths, items
   gained/lost) so it can never be contradicted later, and clears the encounter block.
6. **Pairs with imagery.** Encounter turns set `illustrate.kind = "action"` with high priority (§9),
   so fights are the moments most likely to be illustrated.

### 10.3 Data model delta
New `EncounterSchema` (on `story.json`, nullable when not in combat):
```jsonc
{
  "active": true,
  "kind": "combat | chase | standoff",
  "round": 2,
  "participants": [ { "id": "npc_…", "condition": "hurt" } ],
  "playerCondition": "unharmed",
  "stakes": "Cut your way to the gate before the alarm spreads."
}
```
New delta keys: `deltas.encounter.start`, `deltas.encounter.round` (condition changes),
`deltas.encounter.end`. Condition changes are applied by `stateExtractor`.

### 10.4 UI
- A compact **Encounter** strip above the composer during a fight: kind, round, each participant's
  condition, and the player's condition. Dice cards already render per check.

### 10.5 Acceptance criteria
- Starting a fight opens an encounter; each round resolves through `dice.js` with mental‑status
  modifiers applied, and conditions advance with outcomes.
- Ending a fight writes a durable ledger fact; the result is respected in later chapters (ties to §4).
- Disengaging/parleying ends combat cleanly via the GM, never trapping the player.

---

## 10A. D2 — Social, physical & daily‑life interactions (improvement)

> *"Most interactions are just conversation — add more physical / non‑conversational interaction
> between characters or the world. Not only fighting: romance, drinking, shared daily life."*

### 10A.1 Goal
Make the world feel lived‑in: vary how the player and NPCs interact beyond dialogue — physical
actions, shared activities (a meal, a round of drinks, a game, music, work), romance/intimacy, and
quiet daily‑life beats — and make those interactions *matter* by moving relationships and mental
status. Combat (§10) is one kind of non‑conversational interaction; this is the cooperative,
social, and mundane other half.

### 10A.2 Why it's mostly conversation today (root cause)
- `system_gm.md` frames the GM around *voicing NPCs* and *asking the player*, with no instruction to
  vary interaction **modality**; the model's default for "respond to an NPC" is more dialogue.
- The example `suggestedActions` in the prompts are conversational ("Approach Captain Roel", "Ask
  about the gate"), so the chips reinforce talking.
- There is no vehicle for downtime: Product Spec §6A.3 says mental status "recover[s] over time/rest"
  and §4.3 sells deepening relationships, but nothing in the loop creates rest/social/physical beats,
  so they rarely occur.

### 10A.3 Design
1. **Interaction palette (prompt‑led).** `system_gm.md` gains an explicit menu the GM draws from each
   scene, choosing what fits the moment:
   - **Physical action** — work, travel, climb, craft, tend a wound, fix a thing, handle an object.
   - **Shared activity** — eat, drink, play a game, make/listen to music, train, gamble, dance.
   - **Romance / intimacy** — flirtation through to closeness, **bounded by content settings** (§10A.4).
   - **Environmental** — manipulate, explore, or use the world (open, search, sabotage, cook, repair).
   - **Daily‑life / downtime** — rest, chores, a quiet meal, people‑watching, small rituals.

   Rule: *when plausible, at least one of the 3–5 `suggestedActions` is non‑conversational*, and
   narration should show characters **doing**, not only talking.
2. **Activity beats (optional cooperative analogue to encounters).** For a *sustained* shared
   activity (a night of drinking, a shared meal, a dance, working side by side, a romance scene), the
   GM may open an `activity` — the cooperative twin of the §10 combat encounter. It can span a few
   beats and resolves into graded *social* outcomes rather than condition damage:
   - **Skill checks where apt**, reusing `dice.js`: a drinking contest → Resolve; a dance →
     Agility/Charisma; crafting → Wits; arm‑wrestling → Strength — same outcome tiers, dramatized.
   - **Mental‑status & relationship shifts** are the payoff: rest lowers Stress; a good night raises
     Morale/Trust; drink lowers Composure (and can feed §10 combat penalties afterward); a tender
     moment raises Trust and the NPC's `relationshipToPlayer`.
   - **Memory/canon**: the activity is recorded (`newMemories` / `canonFacts` *witnessed by that NPC*,
     per §3/the EVALUATION knowledge‑scoping fix) — "shared a bottle of ashwine and traded war
     stories" — so it colors future encounters (Product Spec §6A.3 "feeds NPC memory").
3. **Mental status as the reward loop (closes §6A.3 recovery).** Downtime/social beats are the
   primary *non‑combat* way mental status recovers and relationships deepen, feeding the existing
   Mental‑status and People panels.
4. **Pacing — not every beat is tension.** The chapter manager must tolerate quiet beats: a
   daily‑life turn still counts as a beat, but the GM should not manufacture a crisis every turn.
   `system_gm.md` notes that downtime between turning points is desirable, not dead air.
5. **Imagery tie‑in (§9 / C3).** These moments are illustratable *scenes* — a lamplit tavern, a quiet
   dawn, a shared campfire — so scene images are not just for fights. Action stays *prioritized*, but
   the scene‑image budget covers social/daily moments too (a romance or tavern beat can set
   `illustrate.kind:"scene"`).

### 10A.4 Romance & content boundaries (must‑honor)
Romance/intimacy is gated by the world's `contentBoundaries` (Product Spec §6.4, set automatically
from genre/tone): the GM matches the boundary **tone** (a cozy setting keeps it sweet; a gritty one
may go further) and **fades to black** at the boundary line. `themes_blocked` (e.g.
`sexual_content_with_minors`) is absolute and never depicted. The system prompt restates this
alongside the romance modality so it can't be missed. The same content‑boundary gate governs how
graphic any physical interaction (a brawl, a wound dressed) gets.

### 10A.5 Data model delta
Optional `activity` block on `story.json` (null when idle), and matching deltas:
```jsonc
// story.activity (nullable)
{
  "active": true,
  "kind": "meal | drinks | game | music | craft | work | rest | romance | other",
  "participants": ["npc_…"],
  "beat": 1,
  "summary": "Sharing a bottle of ashwine in the back of the Cinder Rest."
}
// DeltasSchema additions
"activity": {
  "start": { "kind": "drinks", "participants": ["npc_…"], "summary": "…" },
  "beat":  { "summary": "…" },          // continue the activity another beat
  "end":   { "outcome": "…", "summary": "…" }
}
```
Effects (mental status, relationships, memories, inventory — e.g. a gift) flow through the **existing**
delta keys; `activity` only frames the beat. `ActivitySchema` is added to `src/schemas.js`.

### 10A.6 UI
Reuse the §10 encounter‑strip pattern as a softer **Activity** chip above the composer during a
sustained activity (kind + participants), e.g. "🍷 Drinks with Roel — together". No new panel
required; relationship/mental changes already surface in their existing panels, and any scene image
renders inline (§9) and is clickable to full size (§5).

### 10A.7 Acceptance criteria
- In a low‑stakes scene, suggested actions reliably include ≥1 non‑conversational option, and
  narration features physical/social/daily interaction, not only dialogue.
- A sustained activity (e.g. drinking) resolves with mental‑status + relationship shifts and writes a
  witnessed memory the NPC recalls later.
- Resting/quiet beats recover Stress over time per the mental‑status rules.
- Romance honors `contentBoundaries`: tone matches the world, fades to black at the boundary, and
  `themes_blocked` never appears.
- The chapter manager allows quiet beats without forcing a turning point every turn.

---

# Part E — Resilience

## 11. E1 — Auto‑retry when out of credit / rate‑limited (improvement)

> *"Resend the response after enough credit for the API call."*

### 11.1 Goal
A turn must not be lost because the Claude API was momentarily rate‑limited or the account hit a
spend/credit limit. The call should automatically retry once capacity is available, with the player
informed rather than seeing a hard error.

### 11.2 Current behavior (code‑level)
`src/claude.js` `create()` retries **once** after 800 ms only on `status === undefined || >=500 ||
429`. It does **not** distinguish credit/billing exhaustion (commonly HTTP 400 with
`error.type: "invalid_request_error"`/`"billing"` or 429 with
`type: "rate_limit_error"`), and a single short retry won't survive a real rate window or a
credit top‑up.

### 11.3 Design
1. **Classify failures.** Map the Anthropic error into categories:
   - `transient` — 5xx, network/timeouts, `overloaded_error`.
   - `rate_limit` — 429 / `rate_limit_error` (honor `retry-after` header when present).
   - `credit` — billing/quota exhaustion (insufficient credit).
   - `fatal` — bad request, auth, validation — do **not** retry.
2. **Backoff policy.** Centralize retry in `claude.js`:
   - `transient`/`rate_limit`: exponential backoff with jitter, honoring `retry-after`, up to
     `CLAUDE_MAX_RETRIES` (default 5) capped at `CLAUDE_MAX_BACKOFF_MS` (default 60 s).
   - `credit`: longer, bounded polling retry (e.g. every `CLAUDE_CREDIT_RETRY_MS`, default 30 s, up to
     `CLAUDE_CREDIT_RETRY_TOTAL_MS`, default 10 min) — "resend once there's enough credit."
   - `fatal`: throw immediately (unchanged).
   These wrap **both** the low‑level call and the structured self‑correcting retry in
   `callGMStructured`, so a parse‑retry that then hits a rate limit also backs off.
3. **Tell the player.** Surface a non‑fatal status to the UI. Options, simplest first:
   - The turn request stays open while the server retries, and the client shows a "⏳ Waiting for API
     capacity / credit — retrying…" state instead of the typing dots (the existing `showTyping`
     element gets a waiting variant).
   - If total retry budget is exhausted, return a structured `{ retryable: true, reason }` so the UI
     can offer a **Retry** button that re‑submits the exact same input (the player's turn text is
     preserved client‑side and the server is idempotent for an un‑applied turn).
4. **No partial state on failure.** A turn that fails before Claude returns valid output must not
   advance `turnCount`, memory, chapter, or persist — verify the pipeline only mutates after a
   successful `callGMStructured` (today most mutation happens after the call; audit and guard so a
   mid‑pipeline throw leaves `story.json` untouched, complementing §A2's authority model).
5. **Config (`.env`).**
   ```
   CLAUDE_MAX_RETRIES=5
   CLAUDE_MAX_BACKOFF_MS=60000
   CLAUDE_CREDIT_RETRY_MS=30000
   CLAUDE_CREDIT_RETRY_TOTAL_MS=600000
   ```

### 11.4 Acceptance criteria
- A simulated 429 with `retry-after` causes the call to wait that long and then succeed without
  losing the turn.
- A simulated credit‑exhaustion error retries on the credit schedule; if it later succeeds, the turn
  completes normally; the UI shows a waiting indicator throughout.
- A fatal error (bad request/auth) fails fast with a clear message and no retry storm.
- No failed turn ever leaves `story.json`/memory partially advanced.

---

## 12. Data model & contract changes (summary)

| Schema (`src/schemas.js`) | Change |
|---|---|
| `CharacterSchema` | + `displayName`, `aliases[]`, `portraitPath` (and relies on existing `visualDescriptor`, `persona`, `canon`) |
| `WorldGenSchema` / `WorldSchema` | + `background { overview, factions[], places[], history, rules }` |
| **New** `LedgerFactSchema` | world‑state ledger fact (§4.4) |
| **New** `EncounterSchema` | combat/action encounter state (§10.3) |
| **New** `ActivitySchema` | cooperative/social/daily activity state (§10A.5) |
| `TurnSchema` | + `sceneImage { path, kind, priority, prompt }` |
| `DeltasSchema` | + `worldState{add,resolve}`, `illustrate{should,kind,prompt,priority}`, `encounter{start,round,end}`, `activity{start,beat,end}`, `canonFacts` (from EVALUATION P0 if not already present) |

## 13. API changes (summary)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/story/:storyId/portrait/:characterId` | Character portrait (render‑on‑demand / placeholder). §7 |
| `GET` | `/api/story/:storyId/scene/:turnIndex` | In‑chapter scene/action image. §9 |
| `GET` | `/api/world/:worldId` | (existing) now includes `background`. §6 |
| `POST` | `/api/story/:storyId/turn` | (existing) may now stream a waiting state / return `{ retryable }`. §11 |

All other routes unchanged. Images continue to be content‑sniffed and served as static bytes.

## 14. New / changed files

```
src/imagePrompt.js     NEW — composeImagePrompt({world,characters,moment}) (§8)
src/ledger.js          NEW — world-state ledger store + context block (§4)
src/encounter.js       NEW — encounter open/round/close helpers (§10)
src/activity.js        NEW — cooperative/social/daily activity open/beat/close helpers (§10A)
src/images.js          + referenceImages support; refresh gemini; per-fetch timeout (§8, §9)
src/claude.js          + error classification + backoff/credit retry (§11)
src/storage.js         + portrait/scene/ledger paths
src/schemas.js         + the §12 schema changes
src/stateExtractor.js  + worldState, encounter, activity, dedupe-by-name (§3, §4, §10, §10A)
src/contextBuilder.js  + WORLD STATE block, structured background, all-character descriptors
src/orchestrator.js    + ledger writes, scene-image queue, encounter/activity wiring, mutate-only-on-success
src/chapters.js        + composeImagePrompt + portrait references
prompts/system_gm.md   + unique-name rule, inventory/world-state authority, illustrate/encounter,
                         interaction palette + activity beats + romance/content gate, canon
prompts/world_gen.md   + structured background output
prompts/opening.md     + emit visualDescriptor/persona for portraits
public/app.js,         + lightbox, World panel, portraits, inline scene images, encounter strip,
public/index.html,       waiting/retry UI
public/styles.css
```

## 15. Suggested build order

1. **A1 duplicate names** + **A2 ledger/inventory authority** — correctness first; both are
   prompt + schema + extractor changes with high player impact.
2. **E1 retry/credit resilience** — small, isolated to `claude.js`; protects everything else.
3. **B1 lightbox** — pure client; immediate visible win, unblocks all later image work.
4. **B2 world background** — schema + prompt + a panel.
5. **C1 portraits** → **C2 portrait‑anchored prompts** → **C3 scene/action images** — build the
   `imagePrompt.js` core once, reuse across all three.
6. **D1 encounters** — depends on A2's ledger (for durable outcomes) and pairs with C3 (action
   images).
7. **D2 interaction variety** — mostly prompt‑led (interaction palette + suggested‑action rule); the
   optional `activity` beats reuse `dice.js` + mental‑status + relationships and the §10 encounter
   plumbing; pair with C3 for downtime/romance scene images. Low‑risk, high‑feel; can land early as a
   prompt‑only first pass, then add `activity` structure.

## 16. Open questions

- **Combat depth:** is the `unharmed→hurt→badly hurt→down` condition track enough, or do we want
  per‑limb/per‑stat injuries? (Default: keep it light per §2.3.)
- **Scene‑image budget:** 3 per chapter a good default, or should it scale with chapter length /
  action density?
- **Reference‑image conditioning:** which provider do we make the "consistency" default —
  Cloudflare FLUX (needs a token) for real img2img, or stay keyless Pollinations and accept
  descriptor‑only consistency?
- **Credit‑retry UX:** hold the HTTP request open while retrying (simpler) vs. return immediately and
  let the client poll/retry (more robust for long waits)?
- **Duplicate‑name disambiguation:** auto‑suffix (`Roel (2)`) vs. always require the GM to provide a
  distinct `displayName`?
- **Interaction variety (§10A):** is a prompt‑only first pass (interaction palette + the
  "≥1 non‑conversational suggested action" rule) enough, or do we want the structured `activity`
  beats from day one? And how explicit should the romance dial be — purely tone‑driven from
  `contentBoundaries`, or a player‑set preference at story start?
```
