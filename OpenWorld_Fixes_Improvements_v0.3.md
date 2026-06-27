# OpenWorld — Fixes & Improvements (v0.3)

**Two image bugs + richer generated character profiles, on top of the v0.2 enhancements.**

| | |
|---|---|
| **Document type** | Fix / Improvement Delta Specification |
| **Companion to** | `OpenWorld_Product_Spec.md`, `OpenWorld_Technical_Spec_MVP.md`, `OpenWorld_Enhancements_Spec_v0.2.md`, `EVALUATION_AND_FIXES.md` |
| **Version** | 0.3 (Draft) |
| **Owner** | Ning |
| **Last updated** | 2026-06-23 |
| **Status** | Draft for review |

---

## 1. Scope

A small, surgical slice on top of the now‑implemented v0.2 work (lightbox, portraits, scene/action
images, character persona/canon all exist in the codebase). It fixes two image‑layer bugs the user
hit in play, and upgrades character generation from a freeform `persona` string to a **structured
profile** (personality, faction, occupation, powers, weapons, …) that is fed — together with scoped
memory — into every interaction.

| # | Requirement (verbatim intent) | Section |
|---|---|---|
| Fix 1 | Chapter gallery only shows the first chapter image after clicking other images | §3 (F1) |
| Fix 2 | 429 on image generation shouldn't be shown immediately; show the image when it's being generated | §4 (F2) |
| Imp | Generate character settings too — personality, characteristics, faction, occupation, power, weapons, etc.; consider this **and memory** for interactions | §5 (I1) |
| Imp | Items characters carry aren't only the player's inventory — weapons + things important to them, per character | §5A (I2) |

This builds directly on v0.2 §5 (lightbox), §7–§9 (portraits/scene images), §11 (credit‑retry pattern,
reused here for images), and the knowledge‑scoping/`canon` work from `EVALUATION_AND_FIXES.md`.

---

# Part A — Fixes

## 3. F1 — Gallery lightbox always opens the first chapter image

### 3.1 Symptom
In the chapter gallery, clicking *any* thumbnail opens the lightbox on **chapter 1's** image. The
←/→ arrows then page from chapter 1, so later chapters are only reachable by paging, never by
clicking them directly.

### 3.2 Root cause (exact)
A relative‑vs‑absolute URL mismatch in the lightbox index lookup.

- `chapterImgURL(n)` returns a **relative** string, e.g. `"/api/story/<id>/image/2"`
  (`public/app.js:47`).
- `loadGallery()` builds the lightbox `group` with those **relative** `src` values
  (`public/app.js:618–621`), then wires each thumb with
  `zoomable(img, img.src, group[i].caption, group)` (`public/app.js:628`).
- But `img.src` (the DOM property) is the browser‑**resolved absolute** URL, e.g.
  `"http://localhost:3000/api/story/<id>/image/2"`.
- `zoomable`'s click handler locates the starting slide with
  `group.findIndex((g) => g.src === src)` (`public/app.js:106`). Because `g.src` is *relative* and
  `src` is *absolute*, the equality **never matches** → `findIndex` returns `-1` →
  `Math.max(0, -1)` → **index 0** → the lightbox always starts on chapter 1.

(The same `zoomable` is used for chapter cards, portraits, and scene images, but those pass **no
group** and open a single image, so they're unaffected — this bug is gallery‑only.)

### 3.3 Fix
Pass the **known index** explicitly instead of recovering it by fragile string equality. Smallest
change with no behavior risk:

1. Give `zoomable` an optional explicit index:
   `zoomable(imgEl, src, caption, group, index)` — when `index` is provided, the click handler calls
   `Lightbox.open(group, index)` directly and skips `findIndex`.
2. In `loadGallery()`, pass the loop index: `…forEach((img, i) => zoomable(img, group[i].src,
   group[i].caption, group, i))`. Also pass `group[i].src` (relative, matching the group) rather than
   `img.src`, so any remaining `findIndex` path stays consistent.
3. Defensive: if `findIndex` is ever still used, compare on a normalized URL (e.g. strip origin) so
   relative/absolute can't diverge again.

### 3.4 Acceptance criteria
- Clicking the thumbnail for chapter *N* opens the lightbox **on chapter N**.
- ←/→ cycle through all chapters starting from the clicked one; wrap‑around still works.
- Chapter‑card, portrait, and scene‑image zoom continue to open the correct single image.

---

## 4. F2 — Image 429s shouldn't surface or block; show "generating", fill in when ready

### 4.1 Symptom
When the image provider returns **HTTP 429 (rate limited)**, illustrations don't appear and the
provider keeps getting hammered. The user's intent: *don't try to show the image immediately and
don't surface the error — show that it's being generated, then display it once it's ready.*

### 4.2 Root cause (exact)
Image rendering is **synchronous inside the HTTP request** and has **no rate‑limit handling**:

- The chapter/portrait/scene routes do `await renderImage(...)` *inside the request* and, on any
  failure, fall through to a placeholder served with `Cache-Control: no-store`
  (`server.js:192`, `:252`, `:296`; placeholder at `:231–233`, `:289`, `:318`).
- `renderImage` / `fetchT` treat every non‑OK response identically — `throw new Error("HTTP 429")`
  caught and collapsed to `null` (`src/images.js:47–50`, `:64`). There is **no `Retry‑After`
  awareness and no backoff** (unlike the Claude path, which got credit/rate handling in v0.2 §11).
- Because the placeholder is `no-store`, every gallery re‑render and every chapter‑card paint
  **re‑requests** the image, each request firing a fresh synchronous render → a **429 storm**, and
  the slot stays blank with no signal that an image is coming.

### 4.3 Design — asynchronous render jobs with rate‑limit‑aware retry + a "generating" state
Mirror the v0.2 §11 Claude credit‑retry pattern, for images.

1. **Background render queue (`src/imageQueue.js`, new).** A tiny in‑process queue keyed by image id
   (`chapter:<id>:<n>`, `portrait:<id>:<charId>`, `scene:<id>:<turn>`), with:
   - **Single in‑flight per key** (replaces today's ad‑hoc `_imgRenders` map) + a small global
     concurrency cap (`IMAGE_CONCURRENCY`, default 2).
   - **Rate‑limit‑aware retry**: on HTTP 429 honor the `Retry-After` header; otherwise exponential
     backoff with jitter; on 5xx/timeout retry; on fatal (4xx≠429, missing creds) fail fast. Bounded
     by `IMAGE_MAX_RETRIES` (default 4) and `IMAGE_RETRY_TOTAL_MS` (default 5 min).
   - **Status per key**: `pending | rendering | ready | failed`.
2. **Routes become non‑blocking.** On request for an image not yet on disk and with a provider
   enabled and a prompt available:
   - **Enqueue** the job (idempotent) and **immediately** return the placeholder — but a *"generating"*
     placeholder — with header `X-Image-Status: pending` (or `failed` once the budget is exhausted).
   - Never `await` the render inside the request. This removes both the blocking and the 429 surface.
3. **`src/images.js` classifies failures.** Provider helpers throw a typed error
   (`{ status, retryAfterMs?, fatal? }`) instead of a flat `Error("HTTP 429")`, so the queue can
   decide retry‑vs‑give‑up and honor `Retry-After`. Reads `Retry-After` (seconds or HTTP‑date).
4. **Distinct placeholders.** `placeholder.js` gains a **"generating…"** variant (subtle shimmer +
   "illustration generating") vs the existing plain caption, and a terminal **"unavailable"** variant
   for `failed`. Pending placeholders stay `no-store`; a *ready* image is served normally
   (cacheable).
5. **Client polls and swaps (`public/app.js`).** When an `<img>` for a chapter/portrait/scene loads a
   *pending* placeholder (detected via a HEAD/status check or the `X-Image-Status` header on a
   `fetch`), poll `…/image/:n` (cache‑busted `?t=`) on a backoff (e.g. 3s → 6s → 12s, cap ~30s) until
   `ready`, then swap `src`. Show a small "generating illustration…" affordance meanwhile; stop on
   `failed` with an "unavailable" note. A lightweight `GET …/image/:n/status` endpoint returning
   `{ status }` keeps polling cheap (no image bytes).
6. **Keep images off the turn's critical path.** Confirm chapter close stores `imagePath: null` and
   leaves rendering to the queue (it already uses the on‑demand route); the turn response never waits
   on an image. (Consistent with v0.2 §2 principle 2.)

### 4.4 Config (`.env`)
```
IMAGE_CONCURRENCY=2
IMAGE_MAX_RETRIES=4
IMAGE_RETRY_TOTAL_MS=300000
IMAGE_POLL_MS=3000          # client base poll interval
```

### 4.5 Acceptance criteria
- A simulated provider **429** never appears to the user and never blocks a turn or a panel render;
  the slot shows a "generating…" state.
- The queue makes **one** in‑flight attempt per image, honors `Retry-After`, and backs off — no 429
  storm under a gallery with several un‑rendered chapters.
- Once the provider succeeds, the image **appears automatically** (client poll swaps it in) without a
  manual refresh.
- After the retry budget is exhausted, the slot shows a terminal "unavailable" state, not an error,
  and a later session can still render it on demand.

---

# Part B — Improvement

## 5. I1 — Generate structured character profiles, and use them (with memory) in interactions

### 5.1 Goal
Characters should be *authored*, not just named. At creation, generate a **structured profile** —
personality, characteristics, faction, occupation, powers/abilities, weapons/gear, background,
motivations — for the player and major NPCs, and feed that profile **together with each character's
scoped memory** into every interaction so behavior is consistent and grounded.

### 5.2 Where we are today
The v0.2 work added `persona` (a freeform bio/voice string) and `canon` (an append‑only fact list) to
`CharacterSchema` (`src/schemas.js:62–63`). That helps consistency but:
- It's **unstructured** — faction, occupation, powers, and gear are buried in prose (or absent), so
  they can't be displayed, reasoned over, or reliably honored (e.g. "what weapon does this NPC
  have?", "are they Ashguild or Free Companies?").
- Generation prompts don't *ask* for these fields, so the model supplies them inconsistently.
- The per‑turn NPC context block carries role + mental status + persona, but not a crisp,
  enumerated profile, so capability/affiliation drift still slips through.

### 5.3 Design
1. **Add a structured `profile` to the character model** (complements, doesn't replace, `persona`/
   `canon`). `CharacterProfileSchema`:
   ```jsonc
   {
     "occupation": "harbor‑gate captain",
     "faction": { "name": "The Ashguild", "rank": "captain", "standing": "loyal" },
     "personality": ["dutiful", "suspicious of outsiders", "secretly weary"],
     "characteristics": ["broad‑shouldered", "burn‑scarred jaw", "clipped speech"],
     "powers": [ { "name": "Emberward", "summary": "briefly dampens flame", "stat": "Resolve", "cost": { "Stress": 10, "Composure": -5 } } ],
     "weapons": [ { "name": "boarding hook", "summary": "long reach, hooks shields" } ],
     "gear": [ { "name": "gate keys", "summary": "opens the lower wards" } ],
     "background": "Rose through the ranks after the Cinder Night; lost a brother to the plague.",
     "motivations": ["keep the gate from falling", "atone for the brother he couldn't save"],
     "speechStyle": "terse, military, drops articles when stressed"
   }
   ```
   Depth scales with importance: major NPCs get a full profile; bit players get a light one (a couple
   of fields). All fields optional/defaulted so partial profiles validate.
2. **Faction ties to the world.** `faction.name` should reference a faction from the world
   `background.factions` (v0.2 §6) when one fits; world‑gen may add factions as needed. This keeps
   affiliations coherent across characters.
3. **Generate at every creation point.**
   - `prompts/opening.md` + `OpeningSchema`: emit a `profile` for the player and each opening NPC.
   - `prompts/system_gm.md` + `DeltaNpcSchema`: emit a `profile` when introducing `newNpcs`
     mid‑story (scaled to how important the NPC seems).
   - Powers/weapons assigned at creation must fit the world (`statSchema`, tone, `contentBoundaries`)
     and the role.
4. **Feed profile + scoped memory into interactions (the core of "consider this and memory").**
   In `contextBuilder.js`, the NPC‑in‑scene block becomes, per present NPC: name/displayName, faction
   + occupation, 2–3 key personality traits, notable powers/weapons/gear, current mental status,
   **and the memories that NPC witnessed** (knowledge‑scoped per `EVALUATION_AND_FIXES.md`). The GM
   is instructed to voice each NPC from **their profile + only their own memories** — so what they
   know, how they speak, and what they can *do* (powers/weapons) all stay consistent. The player
   block likewise surfaces the player's profile.
5. **Powers carry a light mechanical hook — existing machinery only (resolved).**
   A power is **not** a new subsystem. It has exactly two hooks, both already in the engine, and
   nothing else:
   - **Linked stat.** Invoking a power routes through an ordinary
     `skillCheck(character, power.stat, dc)` in `dice.js`; the DC comes from the usual tiers. There is
     **no power‑specific DC math, no flat bonus, and no auto‑success** — Emberward simply *is* a
     Resolve check.
   - **Cost in mental‑status dimensions.** A power's `cost` is a signed mental‑status delta (e.g.
     `{ "Stress": 10, "Composure": -5 }`) emitted through the **existing** `deltas.mentalStatus` path
     and applied by `applyMentalDelta`. This *is* the resource system: no charges, no cooldowns, no
     new bar. It recovers on rest/downtime via v0.2 §10A for free, and the natural limiter is
     feedback — repeated use raises Stress / lowers Composure, which `mentalStatusModifier` already
     turns into worse subsequent checks.
   - **NPC powers** are GM moves resolved the same way (a contested check on `power.stat` inside the
     §10 encounter), with the cost landing on that NPC's mental status.
   - **Weapons/gear** are unchanged: inventory remains source of truth for what the *player* holds
     (v0.2 §4 ledger); `profile.weapons`/`gear` only describe what a character is *known to* carry, and
     gaining/losing still flows through `inventory.add/remove` + ledger facts.

   Explicitly **out of scope** (defer unless playtesting shows powers feel too soft): numeric DC
   overrides, flat power bonuses, per‑power uses/cooldowns, and any new resource dimension.
6. **Profiles are canon‑grade and updatable.** Treat `profile` like `canon`: never contradict it;
   refine/extend it via a new delta `profileUpdate` (e.g. promotion changes `faction.rank`; a power
   awakens; a weapon breaks). Updates are merged field‑wise, never silently overwritten.
7. **Display (UI).** The character sheet (player) shows the full profile (faction, occupation,
   personality, powers, weapons, background) under the stats; the **People** panel shows each NPC's
   profile in an expandable row; portraits (v0.2 §7) sit alongside, driven by `characteristics` +
   `visualDescriptor`.

### 5.4 Data model delta
```
CharacterSchema     + profile: CharacterProfileSchema   (src/schemas.js)
DeltaNpcSchema      + profile                            (mid‑story newNpcs)
OpeningSchema       player.profile, npcs[].profile
DeltasSchema        + profileUpdate: { "<id|name>": <partial profile> }
WorldGenSchema      (existing background.factions reused for faction names)
```
Within `CharacterProfileSchema`, a **power** is `{ name, summary, stat, cost }` where `stat` is one of
the world's `statSchema` entries and `cost` is a signed mental‑status delta map (e.g.
`{ "Stress": 10, "Composure": -5 }`) applied through `deltas.mentalStatus` on use — **no `uses`,
`cooldown`, DC, or bonus fields** (§5.3.5). A **weapon/gear** entry stays `{ name, summary }`.

`CharacterProfileSchema` fields are all optional with sensible defaults so older saves (profile
absent) load and render via the `persona` fallback.

### 5.5 Prompt changes
- `prompts/world_gen.md` — ensure `background.factions` is rich enough to anchor character factions.
- `prompts/opening.md` — emit `profile` for player + opening NPCs (full for the player and major
  NPCs; powers/weapons appropriate to world + role + boundaries).
- `prompts/system_gm.md` — (a) emit `profile` on new NPCs; (b) **voice each NPC from their profile +
  only their witnessed memories**; (c) don't grant a character a power/weapon/affiliation outside
  their profile without recording it via `profileUpdate` (and inventory/ledger for player gear);
  (d) keep depth proportional to importance; (e) when a character uses a power, resolve it as a
  normal check on the power's linked `stat` and emit the power's `cost` as a `mentalStatus` delta on
  that character — never as a new resource or an auto‑success.

### 5.6 Acceptance criteria
- Each major character created at opening has a structured `profile` with at least faction,
  occupation, ≥2 personality traits, and powers/weapons where the role implies them; bit players have
  a light profile.
- The profile is visible in the character sheet (player) and People panel (NPCs).
- Across ≥15 turns, an NPC's voice, affiliation, and capabilities stay consistent with their profile,
  and they reference only events they witnessed (no leakage of the player's private/earlier actions).
- A power/weapon established in a profile is honored in a later interaction or encounter; one removed
  (broken/stolen, via `profileUpdate`/inventory) is no longer usable.
- Invoking a power runs a `skillCheck` on its linked `stat` and applies its `cost` as a mental‑status
  delta; **no** new resource, charge, or cooldown state is introduced, and the cost recovers on
  rest/downtime (v0.2 §10A).
- Pre‑v0.3 saves (no `profile`) still load and render via the `persona` fallback.

---

## 5A. I2 — Per-character carried items

### 5A.1 Goal
Make "what a character carries" a **first-class, per-character** concept — weapons *and* the things
that matter to them — not just the player's flat inventory. Every character (player + NPCs) holds
their own live items; items can move between characters (give / loot / steal); and "important to
them" possessions carry emotional weight.

### 5A.2 Where we are today (the asymmetry)
- **Player:** a live, mutable `story.inventory` — the source of truth — updated via
  `deltas.inventory.add/remove` (`stateExtractor.js:141–151`) and shown in the Inventory panel.
- **NPCs:** only descriptive `profile.weapons[]` / `profile.gear[]` (`schemas.js:81–82`), rendered as
  bare names in context (`contextBuilder.js:211–212`). Per §5.3.5 these are **canon/descriptive**
  ("what they're *known to* carry"), refined via `profileUpdate` — **not** a live held-items list.
- Result: no live per-character inventory, no way to move an item between characters, no "important /
  keepsake" category, and no concealment. What a character actually holds turn-to-turn lives only in
  prose + the v0.2 §4 ledger's text possession facts.

### 5A.3 Design
1. **Per-character live inventory.** Every `Character` gets `inventory: Item[]` — the live source of
   truth for what they hold. The player's `story.inventory` becomes the player character's inventory
   (alias + migration, §5A.4).
2. **Items gain categories + flags.** `kind` (weapon | armor | tool | consumable | keepsake | quest |
   misc), `equipped?`, `significance?` (why it matters — sentimental/quest), `concealed?` (for
   scoping), `signature?` (a defining item, e.g. the spy's silver dagger).
3. **Reconcile `profile.weapons/gear` (the key decision).** Keep them as the **descriptive/signature
   loadout** that *seeds* `inventory` at creation and feeds voicing + image prompts (v0.3 §8); the
   **live truth is `inventory`**. To avoid drift, the descriptive weapons/gear view is *derived from*
   `inventory` (items with `kind:"weapon"` / `signature:true`) rather than maintained separately.
4. **Transfer + per-character deltas.** Route inventory deltas by character ref and add a move op so
   loot/gift/steal actually relocate the item (§5A.4). Stealing/looting can ride a `dice.js` check.
5. **Authority for all characters (extends v0.2 §4).** A character may only use or lose items in
   *their* inventory; gaining routes through a delta with an in-world cause and must not contradict
   the world-state ledger — the same rule that killed the "phantom weapon," now applied to everyone.
6. **Knowledge scoping (ties EVALUATION issue #3).** `concealed` items are excluded from
   player-facing / shared GM context until revealed in fiction — a hidden knife never leaks.
7. **Mechanics tie-in.** Carried weapons are the combat move menu (v0.3 powers / v0.2 §10): you can't
   swing a blade you dropped, and an NPC fights with what they actually carry.
8. **Emotional weight.** Losing a `significance`/keepsake item emits a `mentalStatus` delta on its
   owner (v0.3 motivations, v0.2 §10A) — the locket from a dead brother *matters*.

### 5A.4 Data model delta
```jsonc
// ItemSchema (extends today's InventoryItemSchema)
{
  "id": "item_…", "name": "boarding hook", "desc": "…",
  "kind": "weapon | armor | tool | consumable | keepsake | quest | misc",
  "equipped": false, "significance": "", "concealed": false, "signature": false
}
```
```
CharacterSchema   + inventory: z.array(ItemSchema).default([])
StorySchema         story.inventory → alias of the player character's inventory (back-compat),
                    dropped after migration
DeltasSchema        inventory becomes per-character:
                      inventory: { "<charRef>": { add: [Item|string], remove: [id|name] } }
                      (back-compat: a bare { add, remove } targets the player)
                    + transfer: [ { from: "<charRef>", to: "<charRef>", item: "<id|name>" } ]
```
`profile.weapons/gear` are retained as descriptive seeds (mark `signature`); the live count is
`inventory`. A one-off `scripts/migrate-inventory.js` moves existing `story.inventory` →
`player.inventory` and seeds NPC inventories from their `profile.weapons/gear`.

### 5A.5 Prompt changes
- `prompts/system_gm.md` — (a) each character carries items in **their own** inventory (weapons +
  things important to them); (b) a character may only use/lose what's in their inventory; gaining
  requires `inventory["<ref>"].add` with an in-world cause and must not contradict the ledger; (c)
  moving an item between characters uses `transfer`; (d) **never narrate another character's
  `concealed` items to the player** until revealed; (e) losing a keepsake/`significance` item emits a
  `mentalStatus` delta on the owner.
- `prompts/opening.md` (+ `OpeningSchema` / `DeltaNpcSchema`) — emit a **starting `inventory`** for
  the player and major NPCs (seeded from the profile loadout), with `kind`, any keepsake
  `significance`, and `concealed` where apt.

### 5A.6 UI
- **Player Inventory panel:** show a `kind` glyph (⚔ weapon, ✦ keepsake, …), `equipped` and
  "important" markers, and `significance` on hover.
- **People panel:** list each NPC's **known (non-concealed)** carried items — especially visible
  weapons — so the player can read the room (a guard's drawn blade). Concealed items are never shown.
- Carried/clickable items reuse the v0.3 §5 lightbox only where they have art; otherwise text rows.

### 5A.7 Acceptance criteria
- Every major character has a live `inventory`; the player's items migrate from `story.inventory`
  with no loss.
- An NPC can only fight with / lose a weapon that is in their inventory; looting a defeated NPC
  relocates the item to the looter via `transfer`.
- A `concealed` item is never surfaced to the player until revealed in the fiction.
- Losing a `significance`/keepsake item applies a mental-status hit to its owner.
- The descriptive `profile.weapons/gear` view stays consistent with live `inventory` (no phantom
  weapon — extends v0.2 §4).
- Pre-I2 saves (flat `story.inventory`, no per-character inventory) migrate and load cleanly.

---

## 6. New / changed files (summary)

```
public/app.js          F1: zoomable(index) + gallery passes group[i].src & i (§3)
                       F2: poll-and-swap pending images; "generating" affordance (§4)
                       I1: render profile in char sheet + People panel (§5)
public/index.html      F2: (optional) status markup; I1: profile containers
public/styles.css      F2: "generating" shimmer + "unavailable" state; I1: profile styles
server.js              F2: image routes enqueue + return immediately; +GET image/:n/status (§4)
src/imageQueue.js      NEW — keyed render queue: concurrency, status, 429/Retry-After backoff (§4)
src/images.js          F2: typed errors w/ status + retryAfterMs; honor Retry-After (§4)
src/placeholder.js     F2: "generating" + "unavailable" placeholder variants (§4)
src/schemas.js         I1: CharacterProfileSchema; profile on Character/DeltaNpc/Opening; profileUpdate (§5)
src/stateExtractor.js  I1: apply profileUpdate (field-wise merge), set profile on new NPCs (§5)
src/contextBuilder.js  I1: profile + scoped memory in player/NPC blocks (§5)
src/worldGen.js        I1: persist player/NPC profiles at opening (§5)
prompts/opening.md     I1: emit player + NPC profiles (§5)
prompts/system_gm.md   I1: emit/maintain profiles; voice NPC from profile + own memory (§5)
prompts/world_gen.md   I1: richer factions for character affiliation (§5)
src/schemas.js         I2: ItemSchema (kind/significance/concealed/signature); character.inventory;
                         per-character inventory + transfer deltas (§5A)
src/stateExtractor.js  I2: apply per-character inventory + transfer; keepsake-loss mental delta (§5A)
src/contextBuilder.js  I2: per-character carried items (known only) in player/NPC blocks (§5A)
src/worldGen.js        I2: seed starting inventory for player + NPCs from the profile loadout (§5A)
prompts/opening.md     I2: emit starting inventory (kinds / keepsakes / concealment) (§5A)
prompts/system_gm.md   I2: inventory authority for all chars; transfer; concealment; keepsake loss (§5A)
public/app.js          I2: item kind glyphs + important markers; known NPC items in People panel (§5A)
scripts/migrate-inventory.js  NEW — I2: story.inventory → player.inventory; seed NPC inventories (§5A)
```

## 7. Suggested build order
1. **F1** — one‑line‑ish client fix; immediate relief, zero risk.
2. **F2** — image queue + typed errors + "generating"/poll; isolated to the image layer.
3. **I1** — schema + prompts first (generation), then context wiring, then UI. Ship generation +
   context before the UI polish, since consistency is the real win.
4. **I2** — extends I1: add `character.inventory` + per-character/transfer deltas + the authority
   prompt rule + migration, then UI. Depends on I1's profile and the v0.2 §4 ledger; do after I1.

## 8. Open questions
- **F2 polling vs SSE:** is client polling on a backoff acceptable, or do we want a small
  Server‑Sent‑Events channel that pushes "image ready" (nicer, slightly more plumbing)?
- **I1 profile depth:** cap powers/weapons (e.g. ≤3 each) to keep context lean, or let major
  characters carry more? How light is "light" for bit players?
- ~~**I1 powers vs stats**~~ — **Resolved (§5.3.5):** powers carry a light hook only — a linked
  `stat` resolved via the normal `skillCheck`, plus a `cost` expressed as mental‑status deltas. No new
  DC math, bonus, resource bar, uses, or cooldowns.
- **Faction model:** keep `faction` as free text referencing world factions, or promote factions to
  first‑class world objects with ids that characters point to?
- **I2 weapons/gear vs live inventory:** derive the descriptive `profile.weapons/gear` *from*
  `inventory` (single source, recommended in §5A.3), or keep both with `signature` flags? And keep
  `story.inventory` as a player alias for back-compat, or drop it once the migration has run?
