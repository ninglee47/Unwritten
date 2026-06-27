# Unwritten

**Your story, until you tell it — an AI-driven role-playing world where you write your own.**

A locally-runnable, single-player AI storytelling game (see
[`OpenWorld_Product_Spec.md`](OpenWorld_Product_Spec.md) and
[`OpenWorld_Technical_Spec_MVP.md`](OpenWorld_Technical_Spec_MVP.md) for the original design specs).
Drop into a living fictional world, pick any role, and shape your own story through free-form choices.
The Game Master and every NPC are played by an LLM (**Google Gemini** by default, with **Claude** as a
live fallback — see Providers below).

## What's here

- **Core loop** — free-text input → AI narration → "what do you do?" + suggested actions.
- **Mechanics** — stats, d20 skill checks, and a **mental-status** system that modifies
  checks, dialogue, and narration.
- **Weighted long-term memory** — memories carry a weight that drives retrieval and updates
  over time (reinforce / decay / re-promote / link).
- **Loose goals/quests** — seeded per world, evolve as the story develops.
- **Chapter structure** — stories segment into chapters, each closing with a recap, turning
  point, and a generated illustration (or placeholder).
- **Save / resume** — everything persists to `./data` as human-readable JSON.
- **Ebook export** — compile a playthrough into an illustrated PDF (title page, TOC,
  per-chapter prose + illustration, character appendix).

## Setup

```bash
npm install
cp .env.example .env     # then edit .env and add your GEMINI_API_KEY (or set LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY)
npm start                # serves UI + API at http://localhost:3000
```

Open <http://localhost:3000>, pick or describe a world, choose a role, and play.

## Providers (v0.4)

Story/text and images run on **Google Gemini 2.5 Flash** by default, behind a runtime switch.
**Claude stays live as a fallback** — flip `LLM_PROVIDER` (and `IMAGE_PROVIDER`) to roll back with no
code change.

- **Text** (`LLM_PROVIDER`): `gemini` (`gemini-2.5-flash`, classifier `gemini-2.5-flash-lite`) or
  `anthropic` (`claude-sonnet-4-6` / Haiku). One `src/llm.js` facade owns the shared structured-output
  pipeline + retry; `src/providers/{gemini,anthropic}.js` are the swappable transports.
- **Images** (`IMAGE_PROVIDER`): `gemini` (`gemini-2.5-flash-image`), `pollinations` (keyless),
  `cloudflare`, `huggingface`, or `none`.

A single `GEMINI_API_KEY` serves both text and images.

## Configuration (`.env`)

| Key | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | Text provider: `gemini` \| `anthropic` (instant rollback). |
| `GEMINI_API_KEY` | — | **Required for Gemini** (text + images). |
| `GEMINI_MODEL` / `GEMINI_CLASSIFY_MODEL` | `gemini-2.5-flash` / `gemini-2.5-flash-lite` | GM model / cheap classifier. |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | ⚠️ image model — **not** `gemini-2.5-flash` (returns text). |
| `GEMINI_SAFETY` | `relaxed` | `relaxed` = `BLOCK_ONLY_HIGH` so the game's content boundaries stay the primary gate. |
| `GEMINI_THINKING` | `on` | `on` improves GM coherence; the classifier always runs with thinking off. |
| `ANTHROPIC_API_KEY` | — | Required only when `LLM_PROVIDER=anthropic`. |
| `MODEL` / `CLASSIFY_MODEL` | `claude-sonnet-4-6` / `claude-haiku-4-5-20251001` | Claude models (fallback path). |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where saves live. |
| `CHAPTER_TARGET_BEATS` | `12` | Story beats per chapter before it can close. |
| `IMAGE_PROVIDER` | `gemini` | `gemini` \| `none` \| `pollinations` \| `cloudflare` \| `huggingface` |
| `IMAGE_TIMEOUT_MS` | `30000` | Abort a slow image render and fall back to a placeholder. |
| `SCENE_IMAGES` | `auto` | In-chapter scene/action images. `off` \| `auto` (on when a provider is set). |
| `SCENE_IMAGE_BUDGET` | `3` | Max non-action scene images per chapter (action/fights are prioritized). |
| `LLM_MAX_RETRIES` | `5` | Retries for transient / rate-limit errors (exponential backoff, honors `retry-after`). Old `CLAUDE_*` names still work. |
| `LLM_CREDIT_RETRY_MS` / `_TOTAL_MS` | `30000` / `600000` | Poll interval / total budget to retry when the provider is out of credit/quota. |
| `IMAGE_CONCURRENCY` | `2` | Max simultaneous background image renders. |
| `IMAGE_MAX_RETRIES` / `IMAGE_RETRY_TOTAL_MS` | `4` / `300000` | Per-image retry budget; image 429s honor `Retry-After` and never surface as errors. |

`pollinations` is keyless and works out of the box; the others need a token (see `.env.example`).
With `IMAGE_PROVIDER=none`, illustrations are SVG placeholders. Images (chapter, **portrait**, and
**scene/action**) render lazily on first view, off the turn's critical path, so a slow provider never
stalls gameplay; images skipped under `none` are backfilled automatically once a provider is set.

## v0.2 enhancements

On top of the MVP loop, this build adds (see `OpenWorld_Enhancements_Spec_v0.2.md`):

- **Consistency fixes** — a canonical character registry (no duplicate-name characters) and a durable
  **World-State Ledger** (`data/stories/<id>/state/ledger.json`) that records consequential outcomes
  — especially *failed* checks — so the story can't later contradict them; inventory is authoritative.
- **Resilience** — Claude calls auto-retry on rate-limit / out-of-credit with backoff; a failed turn
  never advances state, and the UI offers a **Retry** when the budget is exhausted.
- **Visuals** — click any image to open a full-size **lightbox**; per-character **portraits** (reused
  as references for consistent chapter art where the provider supports it); **scene/action images**
  illustrate notable in-chapter moments, with fights prioritized; a player-facing **World** panel.
- **Interaction** — lightweight **encounter mode** for fights (a condition track + contested checks
  via `dice.js`, mental status feeding both ways) and cooperative **activity** beats (meals, drinks,
  music, romance, downtime) that move relationships and mental status, gated by content boundaries.

## v0.5 fixes

See `OpenWorld_Fixes_v0.5.md`:

- **Chapters always end** — a hard cap (`CHAPTER_HARD_CAP_FACTOR`, default 1.5× target ≈ 18 beats)
  force-closes a chapter that the GM never wraps; the recap is told to "land from here" so a forced
  close still reads like a real ending. Context urgency escalates as the cap nears.
- **Mental panel shows the whole scene** — presence is now derived from *anyone the GM modeled this
  turn* (mental/relationship deltas, encounter/activity participants), unioned into `scene.present`
  (which self-heals + persists). A present ref naming an unknown character becomes a real NPC instead
  of vanishing.
- **Gemini no longer drops late `deltas`** — the GM call gets a generous output floor
  (`GEMINI_MAX_OUTPUT_TOKENS`) and bounded thinking (`GEMINI_THINKING_BUDGET`) so `scene.present` /
  `chapterShouldEnd` / `suggestedActions` can't be truncated; a `MAX_TOKENS` finish retries with a
  bigger budget. (`GEMINI_THINKING=on` is safe again — no more `off` workaround.)
- **No duplicates from name variants** — dedup now does a guarded fuzzy pass after an exact-name miss
  ("Orrath" ≡ "Orrath the Unsutured"), with a relational guard that keeps **"Ceth" vs "Ceth's
  Daughter"** distinct, and an ambiguity guard. Legacy saves are left as-is (prevention for new turns).

## v0.3 fixes & improvements

See `OpenWorld_Fixes_Improvements_v0.3.md`:

- **Gallery fix** — clicking a chapter thumbnail now opens the lightbox on *that* chapter (was always
  opening chapter 1 due to a relative-vs-absolute URL mismatch).
- **Image queue** — image rendering moved off the request into a background queue
  (`src/imageQueue.js`): one in-flight attempt per image, a concurrency cap, and **429-aware retry**
  that honors `Retry-After`. A 429 never blocks a turn or surfaces as an error — the slot shows a
  "generating…" placeholder and the client polls (`…/image/:n/status`) and swaps the image in when
  ready; an exhausted retry budget shows a terminal "unavailable" state.
- **Structured character profiles** — characters are authored with a `profile` (occupation, faction,
  personality, powers, weapons/gear, background, motivations, speech style), shown in the character
  sheet and the People panel. Each NPC is voiced from **their profile + only the memories they
  witnessed**. Powers are a light hook only: a linked stat resolved via the normal `skillCheck` plus a
  mental-status `cost` — no new resource, charge, or cooldown. Profiles evolve via `profileUpdate`.
- **Per-character carried items** — every character holds a live `inventory` of typed items (weapon,
  keepsake, tool, …), not just the player. NPCs fight with what they actually carry; items move
  between characters via `transfer` (give / loot / steal); `concealed` items never leak to the player
  until revealed; losing a keepsake hits its owner's mental status. The player Inventory panel shows
  kind glyphs + "important" markers, and the People panel lists each NPC's visible items (a guard's
  drawn blade). Old saves migrate automatically on load, or run `node scripts/migrate-inventory.js`.

## Project layout

```
server.js            Express entry point (UI + JSON API)
src/
  storage.js         filesystem paths + JSON read/write
  schemas.js         zod data models + LLM output schema
  llm.js             provider facade: structured-output pipeline + retry, dispatch by LLM_PROVIDER
  providers/
    gemini.js        Google Gemini transport (text)
    anthropic.js     Anthropic / Claude transport (text, live fallback)
  claude.js          thin re-export of llm.js (back-compat)
  worldGen.js        world / role / boundaries creation + story opening
  contextBuilder.js  assembles the per-turn prompt
  dice.js            d20 skill-check resolution + pre-check classifier
  mentalStatus.js    mental-status model + check modifiers
  stateExtractor.js  applies Claude's structured deltas to state
  memory.js          weighted long-term memory store + retrieval
  goals.js           loose goals / quests
  chapters.js        chapter segmentation, recap, image prompt
  images.js          pluggable image-render adapter
  ebook.js           story → PDF (PDFKit)
  orchestrator.js    the turn pipeline (ties it all together)
  placeholder.js     SVG placeholder for un-rendered chapter images
prompts/             GM, world-gen, opening, and chapter-recap prompts
public/              single-page UI (vanilla HTML/CSS/JS, no build step)
data/                local persistence (gitignored)
```

## How a turn works (`src/orchestrator.js`)

1. **Pre-check** — does the action need a dice/skill check? (cheap classifier → d20 roll)
2. **Build context** — system GM prompt + world bible + retrieved weighted memory + active
   goals + scene/characters + mental status + recent turns + the player input & any roll.
3. **Call Claude** — returns narration + a structured JSON block of state deltas.
4. **State extractor** — apply mental-status / relationship / inventory / scene / NPC / goal
   changes.
5. **Memory manager** — create new memories, reinforce referenced ones, decay the rest.
6. **Chapter manager** — if the beat target is reached at a turning point, close the chapter
   (recap + image) and start the next.
7. **Persist** save + memory to disk and return the new state to the UI.

## API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/world` | Create a world from a premise. |
| `GET` | `/api/worlds` | List world settings. |
| `POST` | `/api/story` | Start a new story from a world + role. |
| `GET` | `/api/stories` | List local stories. |
| `GET` | `/api/story/:id` | Load/resume a story (+ "story so far"). |
| `POST` | `/api/story/:id/turn` | Submit player input → run the turn pipeline. |
| `GET` | `/api/story/:id/chapters` | List chapter records (gallery). |
| `GET` | `/api/story/:id/image/:n` | Chapter image (or SVG placeholder). |
| `POST` | `/api/story/:id/export` | Compile the story into an ebook PDF. |

No database, no accounts — the whole game lives under `./data` and can be backed up by
copying the folder.
