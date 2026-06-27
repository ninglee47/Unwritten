# OpenWorld — Fixes (v0.5)

**Chapter never closing, missing characters in the mental panel, and the Gemini truncation underneath both.**

| | |
|---|---|
| **Document type** | Fix Delta Specification |
| **Companion to** | `OpenWorld_Technical_Spec_MVP.md`, `OpenWorld_Gemini_Migration_Spec_v0.4.md`, `OpenWorld_Fixes_Improvements_v0.3.md` |
| **Version** | 0.5 (Draft) — *fixes track* (distinct from `OpenWorld_Cloud_Deployment_Spec_v0.5.md`) |
| **Owner** | Ning |
| **Last updated** | 2026-06-24 |
| **Status** | Draft for review |

---

## 1. Scope

Three fixes, continuing the `issues.txt` numbering:

| # | Issue | Section |
|---|---|---|
| 10 | Chapter length exceeds 12 beats and keeps going | §3 (F3) |
| 11 | Mental-status panel doesn't show all the characters involved in the scene | §4 (F4) |
| 1 | Player character rendered **twice** in the mental / scene panel | §4.5 (F4b) ✅ |
| — | **Shared root cause:** Gemini drops late `deltas` fields (truncation) | §5 (F5) ✅ |
| — | Duplicate characters from name **variants** (exact-name dedup misses epithets) | §6 (F6) |
| 12 | "Duplicate story" — GM repeats the scene-setting opener across turns | §6A (F7) ✅ |
| — | GM auto-plays the player character / flips to third-person perspective ("respond to Ming") | §6B (F8) ✅ |
| — | Duplicate suggested actions across consecutive rounds | §6C (F9) ✅ |
| — | Hollow duplicate from placeholder name on reintroduction ("orrath_id") | §6D (F10) ✅ |
| — | NPCs know the player's name / call him "Master" unprompted; NPCs know each other on sight | §6E (F11) ✅ |

## 2. The common thread (read first)

Both reported bugs are partly the **same** underlying problem. The fields that drive them —
`chapterShouldEnd` and `scene.present` — both live inside the large, **late** `deltas` object
([system_gm.md:71,82](prompts/system_gm.md)). On `gemini-2.5-flash` with thinking ON, the
`maxOutputTokens` budget is shared with internal thinking tokens, so the tail of the JSON gets
truncated or minified; `zod` defaults then silently turn the missing fields into `false` / `[]`. So
the GM may *intend* to end a chapter or *did* describe a full cast, but the signal never reaches the
engine.

Therefore **F5 (§5) is the cross-cutting fix** that improves F3 and F4 for free. But F3 and F4 each
also have an independent design gap that must be fixed regardless of provider — so all three ship.

---

## 3. F3 — Chapter runs past the target and never closes (issue 10)

### 3.1 Root cause: there is no hard ceiling
A chapter closes only when **both** the GM raises a flag **and** the floor is reached
([chapters.js:17‑19](src/chapters.js)):
```js
return chapterShouldEnd && story.chapter.beatCount >= story.chapter.targetBeats;
```
`targetBeats` (12) is a **floor, not a cap.** The real trigger is the GM setting
`chapterShouldEnd: true`, which the prompt restricts to *"ONLY at a genuine turning point or
cliffhanger"* ([system_gm.md:102](prompts/system_gm.md)). Past the floor, the context only *nudges*
("if this turn reaches a natural turning point… set chapterShouldEnd=true",
[contextBuilder.js:121‑123](src/contextBuilder.js)) — it never forces. If the GM keeps not finding a
"genuine" turning point (models are conservative; quiet player turns don't create one), `beatCount`
just keeps climbing ([orchestrator.js:181](src/orchestrator.js)) with no upper bound.

(Compounded by F5: `chapterShouldEnd` is the *last* delta field, so Gemini truncation drops it →
defaults `false` → the chapter literally cannot end even when the GM meant it to.)

### 3.2 Fix
1. **Add a hard cap.** `shouldCloseChapter` closes the chapter once a ceiling is hit regardless of the
   flag:
   ```js
   const hardCap = Math.ceil(targetBeats * CHAPTER_HARD_CAP_FACTOR); // default 1.5 → ~18
   return (chapterShouldEnd && beatCount >= targetBeats) || beatCount >= hardCap;
   ```
2. **Force a graceful landing.** When the cap (not the flag) triggers the close, pass `forced: true`
   into `closeChapter`; the recap call (`chapter_recap.md`) is told to **land a turning point /
   cliffhanger from the current state** so a forced close still reads like a real chapter ending.
3. **Escalate the nudge.** In `contextBuilder.js`, ramp urgency as beats pass target: at
   `beatCount >= targetBeats` nudge; within ~2 of `hardCap`, instruct strongly to steer to a turning
   point and set `chapterShouldEnd=true` now.
4. **(via F5)** ensure `chapterShouldEnd` survives truncation so intended endings aren't lost.

### 3.3 Deltas
- `src/chapters.js` — `shouldCloseChapter` adds the hard-cap clause; `closeChapter(world, story,
  player, characters, { forced })`.
- `prompts/chapter_recap.md` — a "wrap from here" mode when `forced`.
- `prompts/system_gm.md` / `src/contextBuilder.js` — escalating end-of-chapter guidance.
- `.env` — `CHAPTER_HARD_CAP_FACTOR=1.5` (or `CHAPTER_HARD_CAP_EXTRA=6`).

### 3.4 Acceptance criteria
- No chapter ever exceeds `hardCap` beats.
- A cap-forced close still produces a coherent turning point + recap + illustration.
- A normal close (GM signals at/after `targetBeats`) behaves exactly as today.

---

## 4. F4 — Mental panel misses characters in the scene (issue 11)

### 4.1 Root cause: `scene.present` is unreliable, and it's the *only* source
The panel renders `player + npcsInScene`, and `npcsInScene` is derived **purely** from
`story.scene.present` ([orchestrator.js:243‑246](src/orchestrator.js); rendered at
[app.js:627](public/app.js)). But `scene.present` is only updated when the GM emits
`deltas.scene.present` as an array ([stateExtractor.js:162‑163](src/stateExtractor.js)):
```js
if (Array.isArray(s.present)) { story.scene.present = s.present.map(resolveRef).filter(id => id && characters.has(id)); }
```
So when the GM omits `present` (or sends only the one NPC it's addressing, or omits `scene`
entirely, or it's truncated by F5), `present` goes **stale/incomplete** — a character clearly active
in the narration never appears in the panel. The `.filter(characters.has)` also silently drops any
present ref that doesn't resolve.

### 4.2 Fix — derive presence from who the GM is actually modeling
The robust fix is engine-side: **anyone the GM touches this turn is, by definition, involved.**
1. **Union the effective scene set.** Compute in-scene characters as
   `scene.present ∪ {ids touched this turn by mentalStatus or relationship deltas} ∪
   activity.participants ∪ encounter.participants`. If the GM applied a `mentalStatus` delta to an
   NPC, that NPC shows in the panel even if it forgot to list them in `present`. Have `applyDeltas`
   return the set of `touchedCharacterIds`; the orchestrator merges them into the derived
   `npcsInScene` and **additively** into `story.scene.present` (so it persists and self-heals, and
   the next turn's context is complete too).
2. **Keep GM `present` authoritative for removals.** When the GM *does* send a `present` list, treat
   it as the canonical roster (handles people leaving) — but always re-add this turn's touched
   characters on top.
3. **Strengthen the prompt rule.** `system_gm.md`: whenever the cast changes, emit the **complete**
   `scene.present` (every character in the scene, by id) — not just the one being addressed.
4. **Don't vanish unresolved refs.** A present ref that names an unknown character should route
   through the new-NPC/dedup path (so it becomes a real character that can render), rather than being
   silently filtered to nothing.
5. **(via F5)** ensure `deltas.scene` isn't truncated away.

### 4.3 Deltas
- `src/stateExtractor.js` — collect + return `touchedCharacterIds` (from mentalStatus/relationship
  deltas); resolve-or-create present refs instead of dropping.
- `src/orchestrator.js` — merge touched ids into `npcsInScene` (and additively into
  `story.scene.present`); `deriveUIState` unchanged downstream.
- `prompts/system_gm.md` — "always send the full present roster" rule.

### 4.4 Acceptance criteria
- Every character the GM updates (mental status / relationship) this turn appears in the mental panel.
- A multi-NPC scene shows **all** participants, not just the one being spoken to.
- Resume shows the same in-scene set (because `present` was persisted, not just derived).
- A character who leaves (GM sends a `present` list excluding them) is correctly dropped.

### 4.5 F4b — Player rendered twice in the mental / scene panel ✅ (implemented this session)
**Symptom:** the player character appears twice in the mental-status / scene panel.
**Root cause:** `deriveUIState` builds `npcsInScene` from `scene.present` **without excluding the
player** ([orchestrator.js:243](src/orchestrator.js)), and the GM (or the F4 union) can place the
player's id into `scene.present`. The panel then renders the player once (its own block) and again as
an "NPC in scene"; the `Present:` line doubles too. `decideSceneImage` had the same hazard —
`[player, ...present]` listed the player twice in the image prompt.
**Fix (done):** filter the player out of `present` in **both** spots —
`.filter((c) => c && !c.isPlayer && c.id !== story.playerId)`. Defensive regardless of whether
`scene.present` contains the player. (Save also hotfixed: `"player"` removed from `scene.present`.)
**Acceptance:** the player appears exactly once in the panel and `Present:` line; the image prompt
never lists the player twice.

---

## 5. F5 — Gemini drops late `deltas` fields (shared cause)

### 5.1 Root cause
The structured GM call runs `callGMStructured(..., 3000)` ([orchestrator.js:106](src/orchestrator.js))
→ Gemini `maxOutputTokens: 3000` with **thinking ON** for the GM (only the classifier gets
`thinkingBudget: 0`, [gemini.js:71‑74](src/providers/gemini.js)). On `gemini-2.5-flash` the budget is
**shared between thinking tokens and the visible JSON**, so the tail of `deltas` (which holds
`scene.present`, `chapterShouldEnd`, `suggestedActions`, etc.) is truncated or minified; `zod`
defaults mask the loss as `[]` / `false`. `gemini.js` only catches the *fully empty* reply, not the
*partial/minified* one ([gemini.js:104‑111](src/providers/gemini.js)).

### 5.2 Fix
1. **Raise the GM output budget** to comfortably exceed the worst-case JSON (≈6000–8192) — a
   dedicated `GEMINI_MAX_OUTPUT_TOKENS`, or bump the orchestrator's `3000`.
2. **Bound GM thinking** so it can't starve the answer: set `thinkingConfig.thinkingBudget` (e.g.
   1024) for the `gm` kind, not just `0` for the classifier.
3. **Treat truncation as failure:** in `gemini.js`, when `finishReason === "MAX_TOKENS"`, retry with a
   larger budget instead of returning a minified body that validates to empty defaults.
4. **(Robust) adopt `responseSchema`** for the GM response so required fields (`suggestedActions`
   `minItems: 3`, `scene`, `chapterShouldEnd`) cannot be dropped (v0.4 §4.4 deferred this — these
   bugs are the reason to do it now).

### 5.3 Deltas
- `src/providers/gemini.js` — bounded GM `thinkingBudget`; `MAX_TOKENS` finishReason → retry;
  optional `responseSchema`.
- `src/orchestrator.js` / `.env` — larger structured-call token budget (`GEMINI_MAX_OUTPUT_TOKENS`).

### 5.4 Acceptance criteria
- Under Gemini, every turn returns complete deltas: non-empty `suggestedActions`, a full
  `scene.present`, and a present `chapterShouldEnd` — without needing `GEMINI_THINKING=off` as a
  workaround.
- No silent empty-array/`false` defaults caused by truncation.

---

## 6. F6 — Duplicate characters from name variants (save-audit finding)

### 6.1 Root cause
The dedup **is** implemented: a `newNpcs` entry that resolves to an existing character is merged, not
duplicated ([stateExtractor.js:83‑102](src/stateExtractor.js)), with a prompt-side guard
([system_gm.md:26](prompts/system_gm.md)). But matching is **exact normalized name only** —
`normalizeName` ([util.js:23](src/util.js)) just lowercases, trims, and collapses whitespace. So a
character re-introduced under a **name variant or epithet** doesn't resolve to the existing record and
a duplicate is spawned. Seen live in a save audit: *"Orrath"* / *"Orrath the Unsutured"* / *"Orrath"*
(different roles) became **three** records, while identical-name cases (e.g. *"Edric Vaun"* twice) are
already caught.

### 6.2 Fix — a second, *guarded* fuzzy match pass
Used **only when the exact normalized match misses**, so existing behavior is unchanged for the common
case. Confidence order: exact `id` → exact normalized name → **guarded fuzzy** → create new
(auto-suffixed `displayName`, unchanged).

1. **Core-name extraction.** Strip titles/epithets before comparing: a trailing *"the &lt;Word(s)&gt;"*
   clause (*"Orrath the Unsutured"* → `orrath`), leading honorifics (Captain, Ser, Lady, Elder,
   Master, Dr.), and a trailing comma-appositive (*"Orrath, Elder shaman…"* → `orrath`).
2. **Token-subset match.** Treat A and B as the same person when one's significant-token set is a
   **subset** of the other's **and** they share the same first significant token
   (`orrath` ⊆ `orrath the unsutured` → match).
3. **Relational guard (must NOT merge).** Never merge when the names differ by a **possessive /
   kinship / ordinal** marker — `'s`, "of", "son/daughter/child of", "the Younger/Elder", "II/III".
   This protects legitimately distinct characters like **Ceth vs Ceth's Daughter** (both real in the
   audited save).
4. **Ambiguity ⇒ don't merge.** If the fuzzy pass matches more than one existing character, fall back
   to the current "precise match or give up" behavior — never a silent wrong-merge.
5. On a fuzzy merge, record the variant as an `alias` (existing `mergeIntoExisting` behavior).

### 6.3 Deltas
- `src/util.js` — add `coreName(s)` (strip titles/epithets/appositives), `nameTokens(s)`, and
  `isRelationalVariant(a, b)` (the kinship/possessive/ordinal guard). `normalizeName` is unchanged.
- `src/stateExtractor.js` — in `buildResolver`/`resolveChar`, after the exact-name miss try the
  guarded fuzzy match; on hit, merge + alias. The auto-suffix create path is unchanged.
- **No data migration.** Per decision, **old-build saves are left as-is** — this is prevention for new
  turns only; the one manually reconciled save stands.

### 6.4 Acceptance criteria
- Re-introducing *"Orrath"* when *"Orrath the Unsutured"* exists (or vice-versa) merges into the one
  record and adds the variant as an alias — no new id/file.
- *"Edric Vaun"* twice still merges (exact case, unchanged).
- **"Ceth" and "Ceth's Daughter" remain two distinct characters** — the relational guard blocks the
  merge.
- A name that fuzzy-matches two existing characters does **not** auto-merge (ambiguity → distinct).
- The auto-suffix-for-true-duplicates path and exact-name dedup are unchanged.
- Old-build saves are untouched (no sweep); only new turns benefit.

---

## 6A. F7 — "Duplicate story": GM repeats the scene-setting opener ✅ (issue 12)

### 6A.1 Root cause (two bugs colliding)
Observed live: turns 115, 117, 118 all opened with the identical *"The crisp morning air fills your
lungs… the ley-road hums underfoot…"* paragraph. Two causes stacked:
1. **Narration repetition** — in a static scene (a journey along the ley-road) the GM re-establishes
   the setting with the same opener each turn instead of advancing. Nothing in `system_gm.md` forbade
   restating an already-established scene, and the recent-turns history feeds the model its own prior
   openings to echo.
2. **Truncation (F5)** — turn 117 was cut to *only* that opener (311 chars; the actual answer lost to
   Gemini's thinking budget), so it read as a pure duplicate of turn 118's opening.

> Not a streaming / "show actions too early" issue — turns return complete, and 117/118 were separate
> player inputs (not auto-continue). The returned *content* is what repeats.

### 6A.2 Fix (updated — the static prompt rule alone was NOT enough)
The first attempt (prompt rule only) **still repeated** in play: Gemini kept opening every turn with
*"The crisp morning air…"*, including a 1652-char (non-truncated) turn. Two reasons, both now fixed:

1. **Dynamic anti-repetition guard ✅ (engine — `contextBuilder.js`).** Each turn now injects an
   `# AVOID REPETITION` block listing the GM's own **recent opening sentence(s)** with a directive to
   open differently and not re-describe the established setting. Showing the model the exact text to
   avoid is far more reliable than a static rule.
2. **Prompt-cache fix ✅ (`util.js`).** `loadPrompt` cached prompts forever, so edits to `system_gm.md`
   (the F7 *and* F8 rules) **never reached a running server** — and `.md` files aren't in Node's import
   graph, so a restart/`--watch` didn't reliably pick them up either. `loadPrompt` now invalidates on
   file mtime. *(A one-time server restart is still needed to load these **code** changes.)*
3. **Static rule ✅ (`system_gm.md`)** — the "do not repeat yourself" rule remains as backup.
4. **F5 (truncation) ✅** — implemented (§5), so a truncated bare opener no longer compounds the echo.
5. *(Still optional)* a similarity check that re-prompts once when a new opening closely matches the
   previous turn's — the dynamic guard (1) should make this unnecessary.

### 6A.3 Acceptance criteria
- Across a static multi-turn scene (e.g. travel), consecutive turns do **not** open with the same
  paragraph; each advances the action.
- With F5 in place, no turn is truncated to only its scene-setting opener.
- (Save cleaned: the truncated duplicate turn 117 removed; 118→117; `turnCount` 117.)

---

## 6B. F8 — GM auto-plays the player / flips perspective ✅ ("I should be Ming, not Vorn")

### 6B.1 Symptom
The GM composed the player character's (Ming's) full dialogue, then asked *"How do you respond to
**Ming's** suggestion…?"* — addressing the player in the **third person** and casting them as an
outside party (Vorn / observer) reacting to their own character. (Live: save turn 120.)

### 6B.2 Root cause
The "ask the player" rule ([system_gm.md](prompts/system_gm.md)) forbade *deciding the player's
actions* but never (a) bound the player's identity ("you ARE Ming"), (b) forbade third-person framing
of the player character in the `ask`, or (c) said an NPC's reaction must be **voiced by the GM**, not
requested from the player. Given a terse directive input (*"Suggest a way…"* rather than *"I say…"*),
the model narrated Ming acting, then — unsure whose turn was next — asked the player to react to Ming,
flipping the camera. (A perspective/identity extension of Product Spec §6.3.)

### 6B.3 Fix ✅ (implemented)
Added to the ask-the-player rule: the player IS the player character; always address them in the
**second person** ("you"); the `ask` is ALWAYS directed to you-as-your-character (never *"how do you
respond to <player character>…"*, never third-person about the player character); and when an NPC
should react, the GM **voices** that reaction before handing back — never asks the player to supply an
NPC's line or reply.

### 6B.4 Acceptance criteria
- The `ask` is always second-person and directed to the player as their character; the player
  character is never named in the third person in the `ask`.
- The GM never authors substantive new dialogue/decisions for the player beyond executing the player's
  stated intent.
- An NPC's reaction to the player is voiced by the GM, not requested from the player.
- (Save fixed: turn 120's `ask` → "What do you do?" with player-facing suggestions.)

---

## 6C. F9 — Duplicate suggested actions across rounds ✅

### 6C.1 Symptom
The same move is offered two rounds running. Live examples: turns **122 → 123** both offered *"Ask
Vorn (more) about the redoubt's capabilities"* (exact), with a near-dup chain across 121/122/123 and
again 132 → 133.

### 6C.2 Root cause
The GM generates `suggestedActions` each turn with **no awareness of what it offered last turn** (the
context never showed the previous options), so in a slow-moving scene it re-suggests the same actions.
This is the F7 repetition problem applied to the action chips.

### 6C.3 Fix ✅ (implemented)
1. **Context guard (`contextBuilder.js`)** — the `# AVOID REPETITION` block (F7) now also lists **last
   turn's `suggestedActions`** with a directive to offer *different*, fresh options this turn.
2. **Engine dedup safety net (`orchestrator.js`)** — `dedupeActions()` drops any new suggested action
   that exactly- or near-duplicates (≥60% token overlap) the previous turn's options, keeping the
   originals only if dedup would leave fewer than 2.
3. **Prompt rule (`system_gm.md`)** — "do NOT re-offer the same `suggestedActions` as the previous
   turn; each turn's options must be fresh."

### 6C.4 Acceptance criteria
- Consecutive turns never show the same (or lightly reworded) suggested action.
- The UI always has ≥2 distinct options (dedup falls back rather than emptying the list).
- (Verified: the turn 122→123 case now drops the exact repeat, leaving 2 distinct options.)

---

## 6D. F10 — Placeholder-name duplicate on reintroduction ✅ ("orrath_id")

### 6D.1 Symptom
When a character who had left the scene was reintroduced, a **hollow duplicate** was created — a new
NPC literally named **`"orrath_id"`** (0 canon, 0 relationship), which then went into `scene.present`
*instead of* the real Orrath (`npc_ad193dd7`, 48 canon). (Live: save turn ~203.)

### 6D.2 Root cause
A **new failure mode that F6 does not catch.** The GM emitted a **placeholder/id token in the NAME
field** (`"orrath_id"`) when it meant to *reference* the existing Orrath. F6's fuzzy matching compares
real names/epithets ("Orrath" vs "Orrath the Unsutured") — `"orrath_id"` is a single odd token, so it
neither matched nor was rejected, and the engine minted a hollow new character. (Also surfaced the
recurring F4b "player in present" because the fixes still weren't loaded — no restart yet.)

### 6D.3 Fix ✅ (implemented)
1. **`cleanCharacterName()` (`util.js`)** — strips placeholder decoration: `<…>`/`{…}`, leading
   `npc_`/`npc-`, trailing `_id`/`-id`, and bare technical tokens/hex slugs. `"orrath_id"` → `orrath`;
   `"<npcId>"` → `""`; real names untouched.
2. **Resolver (`stateExtractor.js`)** — `resolveChar` now retries with the cleaned name after an exact
   + fuzzy miss, so `scene.present` refs like `"orrath_id"` resolve to the real character.
3. **`newNpcs` guard (`stateExtractor.js`)** — cleans the name before resolve‑or‑create; **skips pure
   placeholders** (`"<npcId>"`) entirely so they never become a character; ignores placeholder‑looking
   ids; title‑cases a cleaned bare name.
4. **Prompt rule (`system_gm.md`)** — when a character returns, add their *existing* name to
   `scene.present`; never use a placeholder/id token as a name.

### 6D.4 Acceptance criteria
- A `newNpcs` entry named `"orrath_id"` merges into the existing Orrath — no hollow duplicate.
- `"<npcId>"`/`"{name}"`/hex‑slug names are ignored, never created as NPCs.
- `scene.present` containing a placeholder token resolves to the real character.
- Real names and genuine new characters are unaffected.
- (Save reconciled: `"orrath_id"` removed, real Orrath restored to the scene, 2 mis‑witnessed memories
  repointed to him.)

---

## 6E. F11 — Knowledge-scoped names & forms of address ✅

### 6E.1 Symptoms
- Every NPC started calling the player **"Master Ming"** — though no one ever decided to honor him,
  and only Serevaine ever learned his name.
- **Vorn greeted Lysandra by name on first meeting** (save turn 210) — NPC↔NPC knowledge leak.

### 6E.2 Root cause
Names weren't knowledge‑scoped. The context fed the player's **name + role** and *every* present NPC's
full identity to the GM, which voices everyone omniscently — so any NPC could name the player or
another NPC on sight. The "Master" honorific came from the GM reading the role string **"Spear
Master"** as a title, then the recent‑turns history reinforcing "Master Ming" into a snowball. The
narrow `knowsPlayerName` idea wouldn't cover NPC↔NPC; the fix is a general **acquaintance graph**.

### 6E.3 Fix ✅ (implemented) — `knownCharacters` acquaintance model
1. **State (`schemas.js`)** — `character.knownCharacters: string[]` (ids known *by name*); the player is
   a node, so "does NPC know your name?" = is `player` in their list. New delta `introductions`
   (groups who now know each other) + `knownCharacters` on `newNpcs`.
2. **Updates (`stateExtractor.js`)** — `deltas.introductions` adds mutual acquaintance; new NPCs seed
   their `knownCharacters`.
3. **Context (`contextBuilder.js`)** — the player block lists who "know your name" vs. strangers and
   says **don't turn the role into an honorific**; each NPC block lists who they "know by name" vs. is
   a "STRANGER to (address generically, do NOT name until introduced)".
4. **Prompt (`system_gm.md`)** — a "Names & forms of address" rule: name another only if acquainted,
   else generic; emit `introductions` when a name is shared; no role‑as‑honorific; characters address
   each other by what they know.
5. **Seed (`worldGen.js` / `opening.md`)** — opening NPCs know each other but **not** the player by
   default (a newcomer), unless the opening sets `knownCharacters: ["player"]` (e.g. someone who
   summoned the player).

### 6E.4 Acceptance criteria
- An NPC who hasn't learned the player's name addresses him generically; uses "Ming" only after an
  introduction (`introductions`).
- The player's role/class is never converted into an honorific ("Master").
- A character names another NPC only if they're in their `knownCharacters` — Vorn would NOT greet
  Lysandra by name on first meeting.
- (Verified: in a fresh‑meet test, Vorn renders as "STRANGER to: Ming, Lysandra". Existing save
  migrated to everyone‑knows‑everyone — consistent for a 210‑turn cast.)

---

## 7. Files: new / changed
```
src/chapters.js          F3: hard-cap close + forced flag
src/contextBuilder.js    F3: escalating end-of-chapter nudge
src/stateExtractor.js    F4: return touchedCharacterIds; resolve-or-create present refs
                         F6: guarded fuzzy dedup pass (after exact-name miss); record variant as alias
src/util.js              F6: coreName / nameTokens / isRelationalVariant helpers
src/orchestrator.js      F4: union touched ids into present/npcsInScene; F5: bigger token budget
                         F4b: exclude player from npcsInScene + scene-image prompt ✅ done
src/providers/gemini.js  F5 ✅: output floor + bounded GM thinkingBudget + MAX_TOKENS auto-retry
src/contextBuilder.js    F7 ✅: dynamic anti-repetition guard (injects GM's recent openings)
                         F9 ✅: anti-repeat guard also lists last turn's suggestedActions
src/orchestrator.js      F9 ✅: dedupeActions() drops actions repeating the previous turn's
src/util.js              F10 ✅: cleanCharacterName() strips placeholder/id name tokens
src/stateExtractor.js    F10 ✅: resolver retries cleaned name; newNpcs skips placeholders
                         F11 ✅: apply introductions (mutual); seed new-NPC knownCharacters
src/schemas.js           F11 ✅: character.knownCharacters; deltas.introductions; newNpcs.knownCharacters
src/contextBuilder.js    F11 ✅: forms-of-address + per-character "knows by name / STRANGER" annotation
src/worldGen.js          F11 ✅: seed acquaintance at opening (cast knows each other, not the player)
prompts/opening.md       F11 ✅: names not known on sight; declare knownCharacters incl "player"
src/util.js              F7 ✅: loadPrompt mtime reload so prompt edits apply (no stale cache)
prompts/system_gm.md     F3: escalating wrap guidance; F4: always send full present roster
                         F7: anti-repetition rule ✅ done
                         F8: player-identity / second-person ask + voice NPC reactions ✅ done
                         F9: "don't re-offer last turn's suggestedActions" ✅ done
                         F10: reintroduce returning chars by real name; no placeholder names ✅ done
                         F11: names known only via introduction; no role-as-honorific ✅ done
prompts/chapter_recap.md F3: "wrap from here" forced-close mode
.env / .env.example      F3: CHAPTER_HARD_CAP_FACTOR; F5: GEMINI_MAX_OUTPUT_TOKENS
```

## 8. Suggested build order
1. **F5** ✅ done — output floor + bounded GM thinking + MAX_TOKENS auto-retry (`gemini.js`).
2. **F3** — hard cap is a one-line condition + a forced-recap prompt branch.
3. **F4** — touched-id union in the extractor/orchestrator + the prompt rule.
4. **F6** — pure logic in `util`/`stateExtractor`; no migration (legacy saves left as-is). Independent
   of F3–F5, can land any time.
5. **F4b + F7 + F8 + F9 + F10** — ✅ all implemented this session (player-exclusion in
   `orchestrator.js`; anti-repetition + player-identity/perspective + reintroduction rules in
   `system_gm.md`; F9 anti-duplicate actions via context guard + `dedupeActions`; F10 placeholder-name
   guard in `util.js`/`stateExtractor.js`). Small and independent; F7's other half rides on F5.
6. **F11** — ✅ implemented (acquaintance graph: schema + `introductions` + context annotation +
   prompt + opening seed). Includes a one-off save migration (everyone-knows-everyone for the
   established 210-turn save). Needs the restart like the rest.

## 9. Open questions
- **F3 cap size:** `targetBeats * 1.5` (~18) a good ceiling, or tie it to pacing/adaptivity (Tech
  Spec §16 open question on adaptive `targetBeats`)?
- **F4 persistence:** merge touched ids **into** `story.scene.present` (persists, self-heals — chosen
  in §4.2) vs. derive `npcsInScene` only for the UI without persisting (keeps `present` strictly
  GM-authored)?
- **F5 responseSchema scope:** apply Gemini's native schema to the whole GM response now, or start
  with just the high-value required fields (`suggestedActions`, `scene`, `chapterShouldEnd`)?
- **F6 fuzzy aggressiveness:** is core-name + token-subset the right strictness, or also allow
  edit-distance for typo'd names (risk: more false merges)? Confirm the relational-marker list is
  complete (`'s`, of, son/daughter of, Elder/Younger, ordinals).
- **F7 engine guard:** rely on the prompt rule alone, or add a near-duplicate-opening detector that
  re-prompts once when a new narration's first paragraph closely matches the previous turn's (more
  robust, slightly more cost)?
```
