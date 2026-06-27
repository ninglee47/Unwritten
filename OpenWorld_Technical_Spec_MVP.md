# OpenWorld — Technical Specification (Local MVP)

**A locally-runnable, Node.js implementation of the OpenWorld AI storytelling game.**

| | |
|---|---|
| **Document type** | Technical Specification — MVP, local version |
| **Companion to** | OpenWorld_Product_Spec.md |
| **Version** | 0.1 (Draft) |
| **Owner** | Ning |
| **Last updated** | June 21, 2026 |
| **Status** | Draft for review |

---

## 1. Scope

This spec defines a **local, single-player MVP**: it runs on one machine, stores everything on the local filesystem, and uses the **Claude API** for all AI narration, NPC dialogue, and mechanics adjudication.

**In scope**
- Node.js backend (game orchestrator + Claude API integration).
- Node.js-served simple web UI (runs in the browser at `localhost`).
- Local file-based persistence organized as **world-setting folders** + **per-story folders** (each story owns its stories/memories/characters) — see §4.
- Core loop, stats/dice/skill checks, mental status, loose goals, chapter structure, weighted memory.
- **Export a story as an ebook PDF** (chapters + illustrations) — see §9A.

**Out of scope (for this MVP)**
- Multiplayer / accounts / cloud sync.
- Production auth, scaling, databases.
- Image generation is **optional/stubbed** — Claude generates an image *prompt* per chapter; actually rendering it is a pluggable step (see §9).

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Node.js** (≥ 20 LTS) | Single language across front and back. |
| Backend framework | **Express** | Minimal HTTP server + JSON API. |
| AI | **Claude API** via `@anthropic-ai/sdk` | All text generation. |
| Frontend | **Plain HTML/CSS + vanilla JS** (or lightweight React via CDN) | "Simple UI," no build step required. |
| Persistence | **Local filesystem (JSON files)** | No database; human-readable saves. |
| Config | `.env` file (`dotenv`) | Holds `ANTHROPIC_API_KEY`, model, port. |
| Validation | `zod` | Validate AI structured output + API payloads. |

**Why no database:** for a local MVP, JSON files on disk are simple, inspectable, portable, and easy to back up. Memory retrieval is small-scale (one player's story), so in-memory filtering is sufficient.

---

## 3. High-level architecture

```
┌───────────────────────────────────────────────────────────┐
│                     Browser (localhost)                     │
│   Simple UI: story feed · character sheet · mental status   │
│   · quest panel · dice results · chapter gallery            │
└───────────────────────────────┬───────────────────────────┘
                                 │  HTTP (JSON)
                                 ▼
┌───────────────────────────────────────────────────────────┐
│                  Node.js backend (Express)                  │
│                                                             │
│   Routes ──► Game Orchestrator                              │
│                 ├─ Context Builder (assembles prompt)       │
│                 ├─ Claude Client (@anthropic-ai/sdk)        │
│                 ├─ Dice / Skill-Check resolver              │
│                 ├─ State Extractor (post-turn updates)      │
│                 ├─ Memory Manager (weights: add/decay/...)  │
│                 ├─ Chapter Manager (segment + recap + image)│
│                 └─ Ebook Exporter (compile story → PDF)      │
└───────────────────────────────┬───────────────────────────┘
                                 │  read/write
                                 ▼
┌───────────────────────────────────────────────────────────┐
│                  Local filesystem (./data)                  │
│   /worlds/<worldId>/ ........ world setting (background)     │
│   /stories/<storyId>/ ....... one playthrough, owns:        │
│        story · chapters · memories · characters · exports   │
└───────────────────────────────────────────────────────────┘
```

The frontend is dumb: it renders state and sends player input. All game logic lives in the backend orchestrator.

---

## 4. Project structure

```
openworld/
├─ package.json
├─ .env                       # ANTHROPIC_API_KEY, MODEL, PORT
├─ server.js                  # Express entry point
├─ src/
│  ├─ orchestrator.js         # main turn pipeline
│  ├─ claude.js               # Claude API wrapper
│  ├─ contextBuilder.js       # assembles the prompt context
│  ├─ dice.js                 # roll + skill-check resolution
│  ├─ stateExtractor.js       # parse AI output → state updates
│  ├─ memory.js               # weighted memory store + retrieval
│  ├─ chapters.js             # chapter segmentation, recap, image prompt
│  ├─ mentalStatus.js         # mental-status model + modifiers
│  ├─ goals.js                # loose goals / quests
│  ├─ worldGen.js             # world + role + boundaries creation
│  ├─ ebook.js                # compile a story into an ebook PDF
│  └─ storage.js              # paths + JSON read/write helpers
├─ prompts/
│  ├─ system_gm.md            # GM system prompt
│  ├─ world_gen.md            # world/role/boundary generation
│  └─ chapter_recap.md        # end-of-chapter summary + image prompt
├─ public/                    # simple UI (served statically)
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
└─ data/                      # local persistence (gitignored)
   ├─ worlds/                 # ── world settings (background per world)
   │  └─ <worldId>/
   │     ├─ world.json        #    bible, genre, premise, tone, statSchema
   │     └─ boundaries.json   #    default content boundaries for this world
   └─ stories/                # ── one folder per story (playthrough)
      └─ <storyId>/
         ├─ story.json        #    save state: scene, goals, chapter ptr, meta
         ├─ stories/          #    the narrative itself
         │  ├─ transcript.json#       full ordered turn log
         │  └─ chapters/
         │     ├─ <n>.json    #       chapter record (recap, turning point...)
         │     └─ <n>.png     #       chapter illustration
         ├─ memories/
         │  └─ memory.json    #    weighted long-term memory items
         ├─ characters/
         │  ├─ player.json    #    player character (stats, mental status)
         │  └─ <npcId>.json   #    one file per major NPC
         └─ exports/
            └─ <storyId>.pdf  #    generated ebook(s)
```

**Storage model (local-only):**
- **World setting folders** (`data/worlds/<worldId>/`) hold the *background* of each world — its bible, genre/premise/tone, stat schema, and default content boundaries. A world is authored once and can seed many stories.
- **Per-story folders** (`data/stories/<storyId>/`) hold everything for a single playthrough. Each story **owns its own** `stories/` (narrative + chapters), `memories/`, and `characters/` subfolders, plus its `exports/`. This keeps playthroughs fully isolated, easy to browse, copy, or delete by hand, and trivial to back up.

---

## 5. Data models

All persisted as JSON. Shapes below are the canonical schemas (validated with `zod`).

### 5.1 World
```jsonc
{
  "worldId": "uuid",
  "title": "The Ash Coast",
  "genre": "dark fantasy",
  "premise": "A plague-struck kingdom on the edge of war.",
  "tone": "grim, low-magic",
  "worldBible": "Long generated description: factions, rules, places...",
  "statSchema": ["Strength", "Agility", "Wits", "Charisma", "Resolve"],
  "contentBoundaries": {            // §6 product spec — defaulted from setting
    "violence": "allowed",
    "themes_blocked": ["sexual_content_with_minors", "..."],
    "tone": "grim but not gratuitous"
  }
}
```

### 5.2 Story state (`stories/<storyId>/story.json`)
The live game save. Note: characters, the full transcript/chapters, and memories live in their **own subfolders** (referenced by id), not inline — `story.json` is the lightweight index.
```jsonc
{
  "storyId": "uuid",
  "worldId": "uuid",                  // → data/worlds/<worldId>/
  "title": "Sera's Long Night",
  "createdAt": "iso",
  "updatedAt": "iso",
  "playerId": "player",               // → characters/player.json
  "npcIds": ["npcId1", "npcId2"],     // → characters/<npcId>.json
  "scene": {
    "location": "The Cinder Gate",
    "timeOfDay": "dusk",
    "present": ["npcId1", "npcId2"],
    "summary": "Short description of current situation."
  },
  "inventory": [ { "id": "...", "name": "Rusted key", "desc": "..." } ],
  "goals": [ /* Goal */ ],
  "chapter": { "index": 2, "beatCount": 7, "targetBeats": 12 },
  "recentTurns": [ /* last N Turns inline for fast context; full log in stories/transcript.json */ ]
}
```

### 5.3 Character (player or NPC)
```jsonc
{
  "id": "uuid",
  "name": "Sera Vane",
  "role": "exiled court spy",
  "stats": { "Strength": 8, "Agility": 14, "Wits": 16, "Charisma": 13, "Resolve": 11 },
  "mentalStatus": {
    "state": "wary",                // headline label
    "dimensions": { "Stress": 40, "Morale": 60, "Trust": 30, "Composure": 70 },
    "notes": "Distrusts authority after the betrayal in Ch.1"
  },
  "relationshipToPlayer": 25         // -100..100, NPCs only
}
```

### 5.4 Memory item (weighted)
```jsonc
{
  "id": "uuid",
  "storyId": "uuid",
  "type": "event | fact | relationship | promise | location | item | mental",
  "text": "Player swore to protect the orphan Tam.",
  "entities": ["Tam", "player"],
  "weight": 85,                      // 0..100 priority
  "createdTurn": 14,
  "lastReferencedTurn": 22,
  "links": ["memoryId_of_Tam_intro"]
}
```

### 5.5 Goal / quest
```jsonc
{
  "id": "uuid",
  "text": "Find out who opened the Cinder Gate.",
  "status": "active | completed | failed | abandoned",
  "weight": 70,
  "spawnedTurn": 3
}
```

### 5.6 Chapter record (`stories/<storyId>/stories/chapters/<n>.json`)
```jsonc
{
  "storyId": "uuid",
  "index": 1,
  "title": "The Gate Opens",
  "recap": "Short prose recap of the chapter.",
  "turningPoint": "Sera chose to betray the captain.",
  "narrativeTurns": [ /* the turns belonging to this chapter, for ebook export */ ],
  "imagePrompt": "A lone spy on a burning rampart at dusk, ...",
  "imagePath": "stories/<storyId>/stories/chapters/1.png",   // null if not rendered
  "startTurn": 1,
  "endTurn": 12
}
```

---

## 6. The turn pipeline (core loop)

Every player input runs through this pipeline in `orchestrator.js`:

```
playerInput
   │
   ▼
1. Pre-check: does this action need a dice/skill check?  ── dice.js / Claude classify
   │  (if yes) → roll d20 + stat mod + mentalStatus mod → graded outcome
   ▼
2. Build context  ── contextBuilder.js
   - system GM prompt + world bible
   - retrieved weighted memory (top-K by weight × relevance)
   - active goals, scene state, character sheets + mental status
   - recent turns (last N)
   - the player input + any dice result
   ▼
3. Call Claude  ── claude.js  → narration + structured deltas (JSON)
   ▼
4. State extractor  ── stateExtractor.js
   - apply mental-status changes, relationship changes,
     inventory/location moves, new NPCs, goal updates
   ▼
5. Memory manager  ── memory.js
   - create new memories (with initial weight)
   - reinforce referenced memories, decay untouched ones, re-promote/link
   ▼
6. Chapter manager  ── chapters.js
   - increment beat count; if chapter target reached & at a turning point →
     close chapter (recap + image prompt + optional render), start next
   ▼
7. Persist save + memory to disk  ── storage.js
   ▼
8. Return to UI: narration, "what do you do?", suggested actions,
   dice result (if any), updated panels, chapter-complete event (if any)
```

### 6.1 Claude structured output
Claude returns **narration text plus a JSON block of state deltas** so the backend can update state deterministically. The system prompt instructs Claude to end every response with a fenced `json` block matching this schema (validated by `zod`; one retry on parse failure):

```jsonc
{
  "narration": "string — what the player reads",
  "ask": "What do you do?",          // the prompt back to the player
  "suggestedActions": ["...", "...", "..."],
  "deltas": {
    "mentalStatus": { "player": { "Stress": +10 }, "npcId": { "Trust": -5 } },
    "relationships": { "npcId": -5 },
    "inventory": { "add": [], "remove": [] },
    "scene": { "location": "...", "present": ["..."], "timeOfDay": "..." },
    "newNpcs": [ /* Character */ ],
    "goals": { "add": [], "update": [ {"id":"...","status":"completed"} ] },
    "newMemories": [ { "type":"event","text":"...","weight":80,"entities":[] } ],
    "chapterShouldEnd": false,
    "needsPlayerInput": true
  }
}
```

> **The "ask the player" rule** is enforced both ways: the system prompt forbids Claude from deciding the player's actions, and the UI always presents `ask` + `suggestedActions` + a free-text box.

---

## 7. Dice & skill checks (`dice.js`)

```
result = d20 + statModifier(character, stat) + mentalStatusModifier(character)
                                              + situationalModifier
outcome:
  result >= DC + 10  → critical success
  result >= DC       → success
  result >= DC - 4   → partial success
  result <  DC - 4   → failure
  natural 1          → critical failure
```

- **Difficulty (DC)** is proposed by Claude during the pre-check classification, or defaults by tier (Easy 8 / Medium 12 / Hard 16 / Heroic 20).
- **`mentalStatusModifier`** maps state/dimensions to a bonus or penalty (e.g., `Composure < 30 → −3` on Resolve checks; `Morale > 80 → +2`). Centralized in `mentalStatus.js`.
- The roll, all modifiers, and the outcome tier are passed into Claude's context so the narration matches the result — **Claude never overrides a roll, it dramatizes it.**
- Roll details are returned to the UI for transparent display.

---

## 8. Weighted memory (`memory.js`)

### 8.1 Storage
One file per story at `stories/<storyId>/memories/memory.json`: an array of memory items (§5.4). Small enough to load fully into memory per turn.

### 8.2 Retrieval (per turn)
```
score(memory) = memory.weight
              + relevanceBonus(memory, currentScene, activeGoals, recentEntities)
return topK(memories by score, K = e.g. 12)
```
Relevance is computed cheaply: entity overlap with the current scene/goals + recency. (A future version can swap in embeddings; not needed for MVP scale.)

### 8.3 Weight updates (after each turn)
- **Create:** new memories get an initial weight from Claude's `newMemories[].weight` (oath/death → high; trivia → low), clamped 0–100.
- **Reinforce:** any memory referenced this turn or tied to an active goal → `weight += R` (e.g., +8), update `lastReferencedTurn`.
- **Decay:** memories untouched for > D turns → `weight -= decayRate` each turn.
- **Re-promote:** if a low-weight memory's entity re-enters the scene → boost.
- **Link:** linked memories receive a fraction of each other's weight changes.
- **Compress, don't delete:** memories below a floor are summarized into a rolling "background" note rather than dropped, preserving continuity cheaply.

---

## 9. Chapters & images (`chapters.js`)

- **Segmentation:** a chapter targets `targetBeats` story beats (configurable, e.g. 12). When the beat count reaches target **and** Claude signals `chapterShouldEnd` (a turning point/cliffhanger), the chapter closes.
- **Recap:** a separate Claude call (`prompts/chapter_recap.md`) produces the chapter title, prose recap, turning point, and an **image prompt**.
- **Image generation:** the Claude API generates the *prompt*, not the image. For the local MVP, rendering is a **pluggable adapter** writing PNGs to `stories/<storyId>/stories/chapters/<n>.png`:
  - `IMAGE_PROVIDER=none` → store the prompt only, show a placeholder (default; zero extra dependencies).
  - `IMAGE_PROVIDER=pollinations` → keyless, URL-based (`https://image.pollinations.ai/prompt/<prompt>`); simplest free option for a local build.
  - `IMAGE_PROVIDER=cloudflare` → Cloudflare Workers AI free allowance (FLUX / Stable Diffusion); needs a free account + token.
  - `IMAGE_PROVIDER=huggingface` / `gemini` → other free-tier options (small monthly credits / API key).
  - For character consistency across chapters, pass a short visual descriptor of the player character into each image prompt.

```js
// example adapter — IMAGE_PROVIDER=pollinations
import fs from "fs";
export async function renderImage(prompt, outPath) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return outPath;
}
```
- The completed chapter (with image or placeholder) is appended to the **chapter gallery** in the UI.

> **Free image-API note (2026):** OpenAI's image API has no free tier and Google retired its older free preview image API in late 2025. The practical free paths are **Pollinations** (keyless, easiest), **Cloudflare Workers AI**, **Hugging Face** (small free credit), and **Google Gemini** image (free tier, API key).

---

## 9A. Ebook export (`ebook.js`)

Lets the player export a story as an **ebook PDF**.

- **Trigger:** `POST /api/story/:storyId/export` (or an "Export ebook" button in the UI).
- **Source data:** assembles from the story folder — `story.json` (title/world), each chapter record in `stories/chapters/` (recap + narrative turns), the chapter images, and optionally a character appendix from `characters/`.
- **Composition (PDF):**
  1. **Title page** — story title, world name, author (player), date.
  2. **Table of contents** — chapter titles + page numbers.
  3. **Per chapter** — chapter title, the full narrative prose (player actions + narration, lightly formatted into readable paragraphs), and the **chapter illustration** placed at the chapter break.
  4. **Optional appendix** — character profiles and a final "story so far" epilogue.
- **Library:** **PDFKit** (`pdfkit`) — pure-Node, no system deps, streams directly to a file; good for text flow + embedded PNGs. (Alternative: render an HTML template and print to PDF, but PDFKit keeps the MVP dependency-light.)
- **Output:** written to `stories/<storyId>/exports/<storyId>-<timestamp>.pdf` and offered to the user as a download.
- **In-progress stories** can be exported too — only completed chapters are included, with the current chapter added as a "to be continued."
- **Formatting helper (optional):** a single Claude pass can clean raw turn text into flowing book prose (strip UI artifacts, smooth transitions) before it hits the PDF — kept optional to control cost.

---

## 10. Claude API integration (`claude.js`)

```js
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function callGM(systemPrompt, messages) {
  const res = await client.messages.create({
    model: process.env.MODEL,          // e.g. "claude-sonnet-4-6"
    max_tokens: 1500,
    system: systemPrompt,
    messages,                          // [{role, content}, ...]
  });
  return res.content[0].text;
}
```

- **Model choice:** `claude-sonnet-4-6` is a good default for narration quality vs. cost/latency; `claude-haiku-4-5-20251001` can be used for cheap classification calls (dice pre-check, relevance). Configurable via `.env`.
- **Streaming:** optional — stream narration tokens to the UI for responsiveness (`client.messages.stream`). The trailing JSON deltas are parsed once the stream completes.
- **Resilience:** retry once on transient errors; on JSON-parse failure, re-prompt Claude to "return only the corrected JSON block."
- **Cost control:** weighted-memory retrieval caps how much history enters context; recent turns are windowed; old turns live only in compressed memory.

---

## 11. Backend API (Express routes)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/world` | Create a world → writes `data/worlds/<worldId>/` (bible + default boundaries). |
| `GET` | `/api/worlds` | List world settings. |
| `POST` | `/api/story` | Start a new story from a world → creates `data/stories/<storyId>/` + opening scene. |
| `GET` | `/api/story/:storyId` | Load/resume a story → returns state + "story so far" recap. |
| `POST` | `/api/story/:storyId/turn` | Submit player input → runs the turn pipeline → narration + state. |
| `GET` | `/api/story/:storyId/chapters` | List chapter records (for the gallery). |
| `GET` | `/api/story/:storyId/image/:n` | Serve a chapter image (or placeholder). |
| `POST` | `/api/story/:storyId/export` | Compile the story into an ebook PDF → returns the file. |
| `GET` | `/api/stories` | List local stories. |

All responses are JSON; images served as static files. No auth (local single-user).

---

## 12. Simple UI (`public/`)

A single page, no build step. Layout:
- **Center:** story feed (scrolling narration) + input box + suggested-action chips.
- **Left rail:** character sheet (stats) + **mental status panel** (player + NPCs in scene).
- **Right rail:** quest/threads panel + inventory + (collapsible) chapter gallery + **"Export as ebook (PDF)"** button.
- **Inline:** dice-roll result card when a check occurs; chapter-complete card with the generated image/placeholder.

`app.js` does `fetch` calls to the API and re-renders panels from the returned state. Optional: use React via CDN if preferred, but vanilla JS keeps it dependency-free.

---

## 13. Configuration (`.env`)

```
ANTHROPIC_API_KEY=sk-ant-...
MODEL=claude-sonnet-4-6
CLASSIFY_MODEL=claude-haiku-4-5-20251001
PORT=3000
DATA_DIR=./data
CHAPTER_TARGET_BEATS=12
IMAGE_PROVIDER=none          # none | pollinations | cloudflare | huggingface | gemini
```

---

## 14. Setup & run

```bash
# 1. install
npm install            # express, @anthropic-ai/sdk, dotenv, zod, uuid, pdfkit

# 2. configure
cp .env.example .env   # add ANTHROPIC_API_KEY

# 3. run
node server.js         # serves UI + API at http://localhost:3000
```

No database, no cloud, no accounts — the whole game state lives under `./data` and can be backed up by copying the folder.

---

## 15. Build order (suggested)

1. `storage.js` + data folders (world / per-story layout) + schemas (`zod`).
2. `claude.js` + a minimal turn (input → narration, no mechanics).
3. Structured JSON deltas + `stateExtractor.js`.
4. `dice.js` + stats + skill checks.
5. `mentalStatus.js` + modifiers wired into checks and narration.
6. `memory.js` weighted store + retrieval + updates.
7. `goals.js` seeding + updates.
8. `chapters.js` segmentation + recap + image prompt (`IMAGE_PROVIDER=none`).
9. Simple UI panels.
10. `ebook.js` PDF export (PDFKit).
11. Image adapter (Pollinations etc.), streaming, polish.

---

## 16. Open technical questions

- Exact **weight formulas** (initial values, reinforce/decay rates) — tune by playtesting.
- Best **`targetBeats`** per chapter and whether to make it adaptive to pacing.
- Whether to keep **all turns** on disk (full transcript) vs. only compressed memory beyond a window.
- Which **image API** to default to (Pollinations is easiest), and how to keep characters visually consistent across chapters.
- Ebook **styling/typography** and whether to offer EPUB in addition to PDF.
- When (if) to graduate from **JSON files to SQLite** as stories grow very long.
