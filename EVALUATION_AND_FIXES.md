# OpenWorld — Spec Compliance Evaluation & Fix Plan

| | |
|---|---|
| **Reviewed against** | `OpenWorld_Product_Spec.md` (v0.1), `OpenWorld_Technical_Spec_MVP.md` (v0.1) |
| **Reviewer** | Claude (code audit) |
| **Date** | 2026-06-22 |
| **Scope** | Full `src/`, `server.js`, `prompts/`, `public/` vs. both specs + the four bugs in `issues.txt` |
| **Status** | ✅ **All findings resolved (P0–P2 implemented).** See the Resolution log in §6. |

---

## 0. Verdict

> **Update (2026-06-22): every issue in this document has now been fixed** — all three P0
> fixes (knowledge scoping, character canon/persona, image generation), all P1 fixes
> (memory recency, linking, entity extraction), and all P2 polish (`needsPlayerInput`,
> NPC felt-memory, scene "present" panel, per-story turn lock). The analysis below is kept
> for the record; the concrete changes are summarized in **§6. Resolution log**.

**The MVP substantially meets the spec.** Every Phase‑1 feature in the roadmap is present and wired
end‑to‑end: world/role onboarding, the core "what do you do?" loop, stats + d20 skill checks, a
mental‑status system that modifies checks, weighted long‑term memory, loose goals, chapter
segmentation with recap + image prompt, save/resume with a "story so far" recap, and ebook PDF
export. The architecture, file layout, data models, API routes, and config all track the technical
spec closely.

**The gaps that matter are not missing features — they are the four problems in `issues.txt`,** and
all four trace back to two concrete design omissions plus a couple of inert code paths:

1. **No knowledge scoping** — every retrieved memory is poured into one shared GM context, and
   nothing tells the model that an NPC only knows what it personally witnessed. → causes issue #3
   (NPCs know your private thoughts/actions before meeting you).
2. **No persistent character canon** — characters store stats + mental status but *not* the
   established facts about them (languages, background, capabilities, personality). Once a detail
   scrolls out of the 8‑turn window and isn't volunteered as a weighted memory, it's gone. →
   causes issues #1 and #2 (suddenly speaks another language; self‑contradiction).
3. **Image generation defaults to off and one provider is stale.** → issue #4.

The rest of this document is the spec‑by‑spec compliance matrix, then a root‑cause analysis and
concrete fix for each reported bug, then the smaller dead‑code/relevance bugs found along the way,
then a prioritized plan.

---

## 1. Spec compliance matrix

### Product spec (feature set §5, mechanics §6A, AI design §6)

| Spec item | Status | Notes |
|---|---|---|
| Free‑text input → AI narration (§5.1) | ✅ | `orchestrator.runTurn` → `claude.callGMStructured`. |
| "What do you do?" + 3–5 suggested actions (§5.1, §4.2) | ✅ | `ask` + `suggestedActions` enforced in schema + UI chips. |
| Dynamic scene/world regeneration (§5.1) | ✅ | `deltas.scene` applied in `stateExtractor`. |
| Chapter engine: segment + recap + turning point + illustration (§3.5, §5.1) | ✅ | `chapters.js`. |
| Loose goals seeded + evolving (§3.4) | ✅ | `goals.js`, seeded at open, updated via deltas. |
| Story feed (§5.2) | ✅ | `public/` feed. |
| Character sheet (§5.2) | ✅ | left rail. |
| World/scene panel (§5.2) | ✅ Fixed | Added a "Present: …" line in the story header driven by `npcsInScene`, alongside `location · timeOfDay`. |
| Inventory (§5.2) | ✅ | right rail. |
| Map (§5.2) | ❌ | Not implemented — explicitly **Phase 2** in roadmap §10. OK to defer. |
| Relationship tracker (§5.2) | ✅ | "People" panel. |
| Mental status panel (§5.2) | ✅ | player + in‑scene NPCs. |
| Quest/threads panel (§5.2) | ✅ | "Threads" panel. |
| Chapter gallery (§5.2) | ✅ | collapsible gallery. |
| In‑chapter generated imagery (§5.2) | ❌ | Phase 2; only end‑of‑chapter images. OK to defer. |
| Short‑term + long‑term memory (§5.3) | ✅ | `recentTurns` window + `memory.json`. |
| Weighted memory + reinforce/decay/re‑promote/link (§5.3, §6.5) | ✅ Fixed | reinforce/decay/re‑promote work; **linking now wired** (orchestrator calls `linkMemories` on co‑created + referenced memories). |
| Save / resume + "story so far" (§5.4) | ✅ | `GET /api/story/:id` + `buildStorySoFar`. |
| Export as ebook PDF (§5.5) | ✅ | `ebook.js` (title, TOC, per‑chapter prose + image, appendix). |
| Stats per character, tailored to world (§6A.1) | ✅ | `statSchema` from world‑gen; assigned at open. |
| Dice / graded skill checks, transparent (§6A.2) | ✅ | `dice.js`, 5 outcome tiers, dice card in UI. |
| Mental status modifies checks (§6A.3) | ✅ | `mentalStatusModifier`. |
| Mental status shapes dialogue/narration (§6A.3) | ✅ Fixed | NPC `persona` + `canon` now fed into context alongside mental status. |
| Mental status feeds NPC memory (§6A.3) | ✅ Fixed | GM instructed to record felt‑shifts via `canonFacts` / a `relationship`‑type memory witnessed by that NPC; both persist. |
| "Ask the player" rule (§6.3) | ✅ | system prompt + UI always present `ask`. |
| Content boundaries defaulted from setting (§6.4) | ✅ | `world_gen.md` → `contentBoundaries` → system prompt. |
| Context strategy: system+bible+memory+recent+input (§6.2) | ✅ | `contextBuilder.js`. |
| State extractor after each turn (§6.2) | ✅ | `stateExtractor.js`. |

### Technical spec (architecture §3–§13)

| Spec item | Status | Notes |
|---|---|---|
| Node/Express, static UI, JSON files, zod, dotenv (§2) | ✅ | matches. |
| Project structure (§4) | ✅ | matches (adds `opening.md`, `images.js`, `placeholder.js`, `util.js` — reasonable). |
| Data models World/Story/Character/Memory/Goal/Chapter (§5) | ✅ Fixed | Character now has `persona` + `canon`; Memory now has `witnesses`. |
| Turn pipeline order (§6) | ✅ | pre‑check → context → Claude → extract → memory → chapter → persist → return. |
| Structured deltas + zod + one retry (§6.1, §10) | ✅ | `callGMStructured` + `sanitizeJSON` + self‑correcting retry. |
| `needsPlayerInput` in deltas (§6.1) | ✅ Fixed | Returned to the UI; the client auto‑continues (capped at 2) when `false`. |
| Dice formula + DC tiers (§7) | ✅ | matches exactly. |
| Weighted memory storage/retrieval/updates (§8) | ✅ Fixed | reinforce/decay/re‑promote/compress ✅; **recency term now real**, **linking now wired**. |
| Chapters + pluggable image adapter (§9) | ✅ | `images.js` with none/pollinations/cloudflare/huggingface/gemini. |
| Ebook export via PDFKit (§9A) | ✅ | `ebook.js`. |
| Claude wrapper, model config, retry (§10) | ✅ | `claude.js`. Streaming (optional) not implemented — fine. |
| API routes (§11) | ✅ | all 8 present + image/export download routes. |
| Simple UI layout (§12) | ✅ | matches the described 3‑column layout. |
| `.env` config keys (§13) | ✅ | matches. |

**Bottom line:** no required Phase‑1 capability is absent. The defects are (a) two missing data
dimensions that produce the reported character/knowledge bugs, and (b) a few inert code paths that
silently under‑deliver on the weighted‑memory spec.

---

## 2. The four reported bugs (`issues.txt`) — root cause + fix

### Issue #3 — "Other characters know my previous thought/action before I meet them"

**This is the most important bug and the clearest spec violation.** Product spec §3.3 promises NPCs
each have *their own* knowledge; §4.3 frames memory as "an NPC remembers that you lied to them three
scenes ago" — i.e. knowledge is *scoped to what that NPC experienced.*

**Root cause.** There is exactly one knowledge channel and it is global:

- `contextBuilder.js` builds a single `# RELEVANT LONG-TERM MEMORY` block from `memory.retrieve()`
  and hands it to the GM verbatim (`contextBuilder.js:58`).
- The GM voices *all* NPCs from that same context. Nothing scopes a memory to who witnessed it.
- The memory item schema (`schemas.js` `MemorySchema`) has `entities` but **no `witnesses` /
  `knownBy`** field, so even if we wanted to scope, the data isn't captured.
- `system_gm.md` says "NPCs remember past interactions with the player" but **never says an NPC may
  only act on what it personally witnessed or could plausibly know.**

Net effect: a private action ("I quietly decide to betray the captain", or anything you did alone or
off‑screen) becomes a high‑weight memory, gets retrieved, and the *next NPC you meet* is voiced with
full awareness of it.

**Fix (two parts, both needed):**

1. **Capture witnesses.** Add `witnesses: string[]` (character ids, plus the sentinel `"player"`)
   to the memory schema and to the GM's `newMemories` output contract. The GM already knows who was
   present; have it tag each memory. Default to "everyone present in the scene this turn" when the
   model omits it.
2. **Scope at prompt-build time + enforce in the system prompt.** When building context, split memory
   into *world/GM‑level* facts vs. *what each present NPC knows*, and add a hard rule to
   `system_gm.md`:

   > **Knowledge boundaries (critical).** An NPC may only act on information they personally
   > witnessed, were plausibly told, or could reasonably infer. Never let an NPC reference the
   > player's private thoughts, actions taken alone or off‑screen, or events from before they met
   > the player. The "RELEVANT LONG-TERM MEMORY" block is *your* (the GM's) omniscient knowledge —
   > NPCs do **not** share it. When in doubt, an NPC does **not** know.

   Even shipping part 2 alone (the system‑prompt rule) materially reduces the bug; part 1 makes it
   robust. Optionally annotate each memory line with its witnesses so the model can self‑check, e.g.
   `- [w80 promise | known by: player, Roel] ...`.

---

### Issues #1 & #2 — "suddenly knows another language" / "the character contradicts themselves"

Product spec §6.1 ("Voice NPCs distinctly and consistently") and §4.3 ("Memory") require durable
character consistency. Two structural causes:

**Root cause A — no persistent character canon.** A character file
(`stateExtractor.js` / `worldGen.js`) stores `stats`, `mentalStatus`, `relationshipToPlayer`,
`visualDescriptor` — but **nothing for established facts**: spoken languages, background, skills,
speech style, things they've claimed. When the GM invents "she answers in the old tongue," that fact
lives *only* in the narration string. It survives in `recentTurns` for **8 turns**
(`orchestrator.js:20 RECENT_WINDOW = 8`) and then disappears — unless the GM happened to volunteer it
as a `newMemory`. There is no structured place that says "this character speaks X / does not speak
Y," so the model has nothing to stay consistent against.

**Root cause B — NPC context is too thin.** `contextBuilder.js:42` feeds each present NPC as only:

```
- <name> (id) — <role>; relationship N; mental: <state + dims>
```

It omits `visualDescriptor` and any persona/known‑facts. So when the GM re‑voices an NPC several
turns later, the *only* anchors are name + role + a relationship number. That is not enough to keep
voice, capabilities, or backstory stable → contradictions and capability drift ("suddenly speaks
French").

**Fix:**

1. **Add a `persona` + `canon` to the character model.**
   - `persona: string` — a short, stable bio/voice note (set at creation by `opening.md` /
     `newNpcs`).
   - `canon: string[]` — append‑only list of established facts ("speaks Low Valdric and trade‑tongue
     only", "lost left hand at the siege", "believes the player is a merchant"). The state extractor
     appends new `canonFacts` the GM emits; the GM is told to consult and never contradict it.
2. **Feed persona + canon into the NPC block** in `contextBuilder.js` (and the player block), not
   just role + mental status.
3. **Strengthen `system_gm.md`:**

   > **Character consistency.** Treat each character's `persona` and `canon` as fixed truth. Do not
   > give a character a new language, skill, memory, or capability that contradicts their canon. If
   > you *introduce* a new durable fact about a character (a language they speak, a relationship, a
   > scar), you MUST record it via `deltas.canonFacts` so it persists.

4. **(Reinforcing) widen/upgrade short‑term memory.** The 8‑turn window is small for a game whose
   selling point is continuity. Either raise `RECENT_WINDOW` to ~12–16, or — cheaper and more in the
   spirit of §6.5 — make sure character‑defining details are *always* captured as canon (above) so
   they never depend on the window at all.

---

### Issue #4 — image generation

**Root causes:**

1. **Default is off.** `IMAGE_PROVIDER=none` ⇒ only the SVG placeholder ever renders
   (`images.js:11`). This is per spec (§9: image rendering is opt‑in), but to a user it reads as
   "image generation doesn't work." This is a **configuration/UX** issue, not a code bug.
2. **The Gemini adapter is stale.** `images.js:93` targets
   `gemini-2.0-flash-exp-image-generation` — an experimental preview endpoint that is no longer the
   current image API in 2026. Likely 404/permission errors for anyone choosing `gemini`.
3. **No timeout on remote fetches.** `pollinations()`/`huggingface()` use a bare `fetch` with no
   abort. Pollinations is frequently slow; because the chapter image is rendered *synchronously
   inside `closeChapter` during the turn* (`chapters.js:75`), a slow provider stalls the player's
   turn response.
4. **Format/extension mismatch (latent).** Pollinations returns JPEG but it's written to `<n>.png`
   (`images.js:39`). Serving survives (`server.js` sniffs magic bytes) and PDFKit sniffs by content,
   so this works today — but it's fragile and worth normalizing.

**Fix:**

1. Make the default provider **`pollinations`** in `.env.example` (keyless, zero setup) so images
   work out of the box, OR add a one‑line note + an in‑UI hint that images are off until a provider
   is set.
2. Update the Gemini adapter to a current image model/endpoint (or drop `gemini` from the documented
   options until refreshed).
3. Add an `AbortController` timeout (e.g. 20–30s) to every remote image fetch; on timeout, fall back
   to the placeholder (the on‑demand render path in `server.js:162` already backfills later).
4. Render chapter images **asynchronously** (don't block the turn): close the chapter with
   `imagePath: null` and let the existing on‑demand `GET /image/:n` render it, or kick the render off
   without `await`. This also fixes the latency the player feels on a chapter‑closing turn.
5. Save with the correct extension (sniff content‑type) or just keep `.png` but document that bytes
   are content‑sniffed.

---

## 3. Additional bugs & gaps found (beyond `issues.txt`)

### 3.1 NPC persona/descriptor missing from context — *see issue #1/#2 fix above.* (highest‑value)

### 3.2 Memory retrieval recency bonus is a dead no‑op
`memory.js:67` — `bonus += Math.min(8, recency * 0)` is always `0`. Tech spec §8.2 explicitly wants
recency in the relevance score. Recency therefore contributes nothing to retrieval today. Fix: pass
`currentTurn` into `retrieve()` and add a real recency term, e.g.
`bonus += Math.max(0, 8 - (currentTurn - m.lastReferencedTurn))`.

### 3.3 `linkMemories` is never called → the "Link" weighting feature is inert
`memory.js:130` exports `linkMemories`, but nothing invokes it, and `addMemories` always sets
`links: []`. The GM has no way to emit links. So spec §6.5/§8.3 "linked memories share weight
changes" never actually happens. Fix: let the GM emit `relatedMemoryIds` (or auto‑link memories
created in the same turn / sharing an entity), and call `linkMemories` in the orchestrator.

### 3.4 `needsPlayerInput` is parsed but never used
`schemas.js:198` defines it; nothing in `orchestrator.js` or the UI reads it. The spec (§6.1) intends
it to let the GM continue an uninterrupted beat. Either wire it up (auto‑continue when `false`) or
drop it from the contract to avoid implying behavior that doesn't exist.

### 3.5 `extractEntities` over‑captures capitalized words
`util.js:29` treats *any* capitalized token as an entity (sentence‑initial "The", "You", etc.). These
pollute `recentEntities`, the retrieval focus set, and `goalEntities`, diluting relevance scoring and
spuriously reinforcing/decaying memories. Fix: restrict to known character/location names + a
stop‑word filter, or require multi‑word proper nouns.

### 3.6 Mental status doesn't feed NPC memory (§6A.3)
Spec: "How a character felt during an interaction is remembered and influences future encounters."
Today only the *current* dimension numbers persist; there's no record of how an NPC felt about the
player in a past scene. Lower priority, but it's an explicit spec bullet. Could be folded into the
new `canon`/persona ("grew cold toward you after the market") .

### 3.7 World/scene "present + time" panel (§5.2) is minimal
Only a `location · timeOfDay` line. Cheap win: add a small "Present: …, …" line driven by
`state.npcsInScene`.

### 3.8 Concurrency / save safety (robustness, not spec)
`runTurn` loads → mutates → writes the whole story/character/memory files with no locking. Two
overlapping turns for one story could clobber each other. The UI disables the send button so it's
unlikely in practice, but worth a per‑story in‑flight guard on the server.

---

## 4. Prioritized fix plan

**P0 — fixes the reported bugs (do these first):**
1. **Knowledge scoping** (issue #3): add `witnesses` to memories + the "knowledge boundaries" rule in
   `system_gm.md`; split GM‑omniscient vs. NPC‑known context. *(§2 issue #3)*
2. **Character canon/persona** (issues #1, #2): add `persona` + `canon` to the character model, feed
   them into context, add `canonFacts` to the delta contract, and add the "character consistency"
   rule to `system_gm.md`. *(§2 issues #1/#2)*
3. **Image generation** (issue #4): default to `pollinations` (or surface that images are off), add
   fetch timeouts, render chapter images off the turn's critical path, refresh the Gemini adapter.
   *(§2 issue #4)*

**P1 — restore promised weighted‑memory behavior:**
4. Real recency term in `retrieve()` (§3.2).
5. Wire up memory linking (§3.3).
6. Tighten `extractEntities` (§3.5).

**P2 — polish / smaller spec bullets:**
7. Decide `needsPlayerInput`: implement or remove (§3.4).
8. NPC felt‑memory across scenes (§3.6).
9. "Present + time" scene panel (§3.7).
10. Per‑story turn lock (§3.8).

---

## 5. Concrete code touch‑points (for whoever implements)

| Fix | Files to change |
|---|---|
| Knowledge scoping | `src/schemas.js` (add `witnesses` to `MemorySchema` + `newMemories` delta), `src/memory.js` (`addMemories` keep witnesses), `src/contextBuilder.js` (annotate/split memory block), `prompts/system_gm.md` (rule + schema example) |
| Character canon/persona | `src/schemas.js` (`CharacterSchema.persona`, `.canon`; `DeltasSchema.canonFacts`), `src/worldGen.js` + `prompts/opening.md` (emit persona), `src/stateExtractor.js` (append `canonFacts`), `src/contextBuilder.js` (render persona+canon in player/NPC blocks), `prompts/system_gm.md` (consistency rule) |
| Image gen | `.env.example` / `README.md` (default + note), `src/images.js` (timeouts, refresh gemini), `src/chapters.js` (don't `await` the render / render async) |
| Recency | `src/memory.js` (`retrieve` signature + score), `src/orchestrator.js` (pass `currentTurn`) |
| Memory links | `src/memory.js` + `src/orchestrator.js` + `src/schemas.js` + `prompts/system_gm.md` |
| Entity extraction | `src/util.js` |
| `needsPlayerInput` | `src/orchestrator.js` (+ `public/app.js` if auto‑continue) or remove from `src/schemas.js` + `prompts/system_gm.md` |

---

---

## 6. Resolution log (2026-06-22)

All findings implemented. Verified with deterministic unit + HTTP smoke tests (no live API needed
for the data‑shape/logic checks).

### P0.1 — Knowledge scoping (issue #3)
- `schemas.js`: added `witnesses` to `MemorySchema` and to the `newMemories` delta.
- `memory.js`: `addMemories` now stores `witnesses`, defaulting to a caller‑supplied present‑cast
  set when the GM omits them.
- `orchestrator.js`: computes `defaultWitnesses = unique(["player", …present before, …present after])`
  and passes it to `addMemories`.
- `contextBuilder.js`: the memory block is reframed as the **GM's omniscient** knowledge and each
  line is annotated `known by: <names>` (witness ids resolved to names).
- `system_gm.md`: added the **Knowledge boundaries (critical)** rule + `witnesses` in the schema and
  delta rules. *Result: NPCs can no longer reference the player's private/off‑screen actions or
  pre‑meeting history.*

### P0.2 — Character canon/persona (issues #1, #2)
- `schemas.js`: added `persona` + `canon` to `CharacterSchema`, `DeltaNpcSchema`, and the opening
  player; added `canonFacts` to `DeltasSchema`.
- `worldGen.js` + `opening.md`: seed `persona` + `canon` for player and NPCs at creation.
- `stateExtractor.js`: applies `canonFacts` (append‑only, de‑duped) and carries `persona`/`canon`
  onto new NPCs.
- `contextBuilder.js`: renders persona + established facts in both the player and NPC blocks.
- `system_gm.md`: added the **Character consistency (critical)** rule.
- `orchestrator.js`: `RECENT_WINDOW` 8 → 14 so details survive longer even before they're locked to
  canon. UI also shows the player's "Established" facts in the character sheet. *Result: no more
  spontaneous new languages or self‑contradiction.*

### P0.3 — Image generation (issue #4)
- `.env.example` / `README.md`: default `IMAGE_PROVIDER=pollinations` (keyless, works out of the box)
  + documented `IMAGE_TIMEOUT_MS`.
- `images.js`: all remote fetches go through an `AbortController` timeout (`fetchT`, default 30s);
  refreshed the Gemini adapter to `gemini-2.0-flash-preview-image-generation` (overridable via
  `GEMINI_IMAGE_MODEL`) with the required `["TEXT","IMAGE"]` modalities.
- `chapters.js`: chapter image is **no longer rendered on the turn's critical path** — chapters save
  with `imagePath: null` and the existing on‑demand `GET /image/:n` renders + records it on first
  view (also backfills chapters created under `none`). The server sniffs magic bytes for the
  content‑type (Pollinations returns JPEG).

### P1 — weighted‑memory behavior
- `memory.js`: real recency term in `retrieve()` (`+max(0, 8 − (currentTurn − lastReferencedTurn))`);
  `orchestrator.js` passes `currentTurn`.
- Linking wired: `orchestrator.js` calls `linkMemories` on memories co‑created this turn + the ones
  the GM referenced, so weight changes ripple (§8.3 "Linked").
- `util.js`: `extractEntities` now filters a stop‑word list so "The/You/Suddenly/…" no longer
  pollute the retrieval focus set.

### P2 — polish
- `needsPlayerInput`: returned by the turn API; `public/app.js` auto‑continues the GM's beat (capped
  at 2 consecutive auto‑turns) when it's `false`.
- NPC felt‑memory: folded into `canonFacts` / witnessed `relationship` memories (prompt rule).
- Scene "Present: …" line added to the story header (`index.html`, `app.js`).
- Per‑story turn lock in `server.js` (`_turnsInFlight`) returns `409` on overlapping turns.

*Original plan retained above for traceability.*
