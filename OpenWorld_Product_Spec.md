# OpenWorld — Product & Concept Spec

**An AI-driven role-playing world where you write your own story.**

| | |
|---|---|
| **Document type** | Product / Concept Specification |
| **Version** | 0.1 (Draft) |
| **Owner** | Ning |
| **Last updated** | June 21, 2026 |
| **Status** | Draft for review |

---

## 1. Summary

OpenWorld is an AI-powered interactive storytelling game. A player drops into a living fictional world, picks any role they want — a wandering swordsman, a court spy, a shopkeeper, a stranded astronaut — and shapes their own story through free-form choices. The game is modeled on tabletop role-playing (like Dungeons & Dragons), but the **Game Master and every non-player character are played by AI**. The AI narrates the world, voices the characters, reacts to what the player does, and pauses to ask the player what they want to do whenever the story needs their input.

The core promise: **no fixed script, no fixed role, no two playthroughs alike.** The player's words drive the world forward, and the world responds with new descriptions, consequences, and characters in real time.

---

## 2. Vision & goals

### 2.1 Vision
A personal, infinite story engine. Anyone can step into a world and live a story that is genuinely theirs — improvised collaboratively with an AI that remembers what happened, keeps the world consistent, and makes choices feel like they matter.

### 2.2 Product goals
- Let a player begin a satisfying story within **60 seconds** of arriving.
- Make the player feel **agency** — their decisions visibly change the world and the plot.
- Keep the world **coherent** across a long session: characters remember, places persist, consequences carry forward.
- Support **any role and any genre** the player imagines, without pre-written campaigns.

### 2.3 Non-goals (for v1)
- Not a multiplayer game (single-player first; co-op is a later phase).
- Not a heavy combat simulator. Mechanics (stats, dice, skill checks, mental status) exist to add tension and shape the story — story always comes first.
- Not a fixed, hand-authored narrative game — the experience is generative.
- Not voice/audio-first (text + visuals first; voice is later).

---

## 3. Core concept & gameplay loop

### 3.1 The pitch in one line
> It's Dungeons & Dragons where the Dungeon Master and the whole cast are AI, and you can be anyone you want.

### 3.2 The core loop

```
   ┌─────────────────────────────────────────────────┐
   │  1. AI narrates the scene / world state          │
   │     (description, what's happening, who's here)   │
   └─────────────────────────────────────────────────┘
                        │
                        ▼
   ┌─────────────────────────────────────────────────┐
   │  2. AI prompts: "What do you do?"                 │
   │     (open input, or suggested actions)           │
   └─────────────────────────────────────────────────┘
                        │
                        ▼
   ┌─────────────────────────────────────────────────┐
   │  3. Player responds in free text (or picks)       │
   └─────────────────────────────────────────────────┘
                        │
                        ▼
   ┌─────────────────────────────────────────────────┐
   │  4. AI resolves the action: consequences,         │
   │     character reactions, new story beats,         │
   │     updated world state                           │
   └─────────────────────────────────────────────────┘
                        │
                        └──────────► back to step 1
```

The loop is the whole game. Everything else — character sheets, the map, inventory — exists to make this loop richer and more consistent.

### 3.3 The three AI roles
1. **Game Master (Narrator)** — describes the world, sets scenes, introduces events and conflict, adjudicates outcomes (including dice/skill checks), and decides when to ask the player for input.
2. **Non-Player Characters (NPCs)** — every other person in the world speaks and acts with their own personality, knowledge, goals, **and mental status**. They remember past interactions with the player.
3. **World Simulator** — tracks the state of the world: time, locations, factions, ongoing consequences of the player's actions, and events happening "off-screen."

### 3.4 Direction: loose goals & quests
The world is open-ended, but never aimless. At world creation the AI seeds **loose goals and quests** that give the player direction without forcing a path — e.g., "find out who burned the village," "earn passage off the colony," "win the duke's trust." These goals:
- Are **suggestions, not rails** — the player can ignore, abandon, or invent their own.
- **Evolve** as the story develops; completing or failing a goal spawns new ones.
- Surface gently in the UI (a "threads" / quest panel) so the player always has something to pull on.

### 3.5 Chapter structure
The story is broken into **chapters of roughly similar length** (measured in story beats / turns). Each chapter is a self-contained arc with a beginning, a rising tension, and a turning point. At the **end of every chapter**, the AI:
1. Resolves the chapter's tension and lands a turning point or cliffhanger.
2. Generates a **chapter illustration** — an AI image capturing the defining moment of that chapter.
3. Produces a short **"chapter recap"** and rolls the seeded goals forward into the next chapter.

This gives the story rhythm, natural save points, and a growing illustrated record of the player's journey.

---

## 4. Player experience

### 4.1 Onboarding (first 60 seconds)
1. Player chooses (or describes) a **world/setting** — pick a preset (high fantasy, cyberpunk, Edo Japan, space frontier, noir city) or write their own one-line premise.
2. Player chooses (or describes) a **role** — pick a suggested archetype or type any role in their own words.
3. The AI generates an **opening scene** tailored to that world and role, and asks: *"What do you do?"*

### 4.2 Playing
- The player reads the AI's narration in a chat-style story feed.
- When the story needs input, the AI **always asks the player what to do**, and offers a small set of **suggested actions** alongside the open text box (so the player can click or type).
- The player types anything — talk to a character, examine something, take an action, make a plan. There are no wrong inputs; the world adapts.
- The rich UI surfaces relevant state without breaking immersion: who's in the scene, where they are, what they're carrying.

### 4.3 What makes it feel good
- **Agency:** consequences are real and persistent. Burn the bridge and it stays burned.
- **Memory:** an NPC remembers that you lied to them three scenes ago.
- **Surprise:** the AI introduces complications and characters the player didn't plan for.
- **Freedom:** the player is never forced down one path; "what do you do?" always means it.

---

## 5. Feature set (v1)

### 5.1 Story engine (core)
- Free-text player input with AI narration response.
- AI-driven "what do you do?" prompts at every decision point.
- Suggested-action chips generated per scene (3–5 options + custom input).
- Scene/world descriptions regenerated dynamically from player actions.
- **Chapter engine:** stories segmented into similar-length chapters, each ending with a turning point, a recap, and a generated chapter illustration.
- **Loose goals/quests** seeded per world and evolved as the story develops.

### 5.2 Rich UI components
| Component | Purpose |
|---|---|
| **Story feed** | Chat-style scrollable narrative — the heart of the screen. |
| **Character sheet** | Player's role, traits, key relationships, status. |
| **World/scene panel** | Current location, who is present, time of day. |
| **Inventory** | Items the player holds or has acquired. |
| **Map** | Visual map of discovered locations (grows as you explore). |
| **Relationship tracker** | How key NPCs feel about the player. |
| **Mental status panel** | Player's (and key NPCs') emotional/psychological state — see §6A. |
| **Quest / threads panel** | Active loose goals and story threads to pull on. |
| **Chapter gallery** | The illustrated record — one generated image per completed chapter. |
| **Generated imagery** | AI scene/character art to set the mood (optional, async). |

### 5.3 Memory & continuity
- Short-term memory: the active scene and recent turns.
- Long-term memory: a structured record of facts (characters met, promises made, items, locations, faction standing, mental-status history) that is retrieved and fed back into the AI as the story grows.
- **Weighted memory:** each long-term memory carries a **weight** that determines its priority for retrieval; weights update as the story develops — see §6.5.

### 5.4 Save / resume
- Sessions persist. Player can leave and return to the same world, mid-story.
- "Story so far" recap generated on resume.

### 5.5 Export as ebook (PDF)
- The player can **export their completed (or in-progress) story as an ebook PDF.**
- The export compiles the full narrative into chapters, with a **title page**, a **table of contents**, each **chapter's prose and its generated illustration**, and an optional epilogue/recap.
- Produces a clean, shareable, keepsake record of the playthrough — the illustrated story the player created.

---

## 6A. Game mechanics & mental status

Mechanics exist to create tension and make outcomes uncertain — not to bury the story in numbers. They stay lightweight and mostly invisible until they matter.

### 6A.1 Stats
Each character (the player and major NPCs) has a small set of **attributes** — e.g., Strength, Agility, Wits, Charisma, Resolve. The exact set is tailored to the chosen world (a cyberpunk world might swap in *Hacking*; a courtly intrigue world might emphasize *Guile*). Stats are set at character creation and can change slowly through the story.

### 6A.2 Dice & skill checks
When the outcome of an action is uncertain and meaningful, the GM calls for a **skill check**:
- A roll (e.g., d20) is combined with the relevant **stat modifier** and any **situational modifiers** (including mental status — see below) against a difficulty set by the GM.
- Outcomes are graded: **critical success / success / partial success / failure / critical failure** — each producing different narration and consequences.
- Rolls are shown transparently in the UI (the player sees the die result and what fed into it), then woven back into the narrative.
- Routine, low-stakes actions don't require rolls — the GM only invokes checks when the result genuinely hangs in the balance.

### 6A.3 Mental status
Every major character — player and key NPCs — carries a **mental status**: a model of their current emotional and psychological state (e.g., *calm, afraid, enraged, grieving, confident, paranoid, exhausted, inspired*), often along a few tracked dimensions such as **Stress, Morale, Trust, and Composure**.

Mental status is a **first-class factor that affects the story and interaction**, not a cosmetic label:
- **It modifies skill checks.** A terrified character takes a penalty to Composure-based actions; an inspired one gets a bonus.
- **It shapes NPC behavior and dialogue.** A paranoid guard interrogates instead of waving you through; a grieving ally may refuse a reasonable request.
- **It shifts the narration.** The GM colors descriptions through the player character's current state.
- **It evolves dynamically.** Events, dialogue, successes, and failures push mental status up or down; states can compound (repeated fear → panic) or recover over time/rest.
- **It feeds NPC memory.** How a character felt during an interaction is remembered and influences future encounters.

The **mental status panel** in the UI shows the player's own state and that of key NPCs in the scene, so the player can read the room and play around it.

### 6A.4 How mechanics inform the AI
Stats, dice results, and mental status are passed into the AI's context each turn so narration, NPC reactions, and consequences stay consistent with the numbers. The AI never contradicts a roll's outcome — it dramatizes it.

---

## 6. AI design

### 6.1 Responsibilities of the AI
- Maintain a **consistent world** (don't contradict established facts).
- Voice NPCs **distinctly and consistently** (personality, voice, motives, **mental status**).
- Adjudicate **dice/skill checks** fairly and dramatize their outcomes.
- **Pace** the story into similar-length **chapters**, ending each with a turning point and illustration.
- **Pace** within a chapter — know when to narrate, when to escalate, and when to stop and ask the player.
- **Always hand control back to the player** when meaningful choices arise.
- Keep responses **immersive and concise** — describe vividly without stalling the loop.

### 6.2 Prompting / context strategy
The AI's context for each turn is assembled from:
1. **System role** — rules of the GM (tone, pacing, "always ask the player," safety bounds).
2. **World bible** — the setting's facts, rules, and tone (generated at world creation, then appended to over time).
3. **Long-term memory** — relevant retrieved facts (characters, events, state) for the current moment.
4. **Recent turns** — the last N exchanges for local coherence.
5. **Current player input.**

A lightweight **state extractor** runs after each turn to update structured memory (new facts, changed relationships, inventory changes, location moves, mental-status shifts, dice outcomes) so the next turn stays consistent.

### 6.5 Weighted long-term memory
Long-term memory does not grow unbounded into the context window. Each memory is stored with a **weight** (a priority/importance score), and retrieval is driven by that weight plus relevance to the current moment.

**How weighting works:**
- Every memory gets an **initial weight** when created, based on significance — a sworn oath or a character death starts heavy; an offhand remark starts light.
- Retrieval each turn pulls the **highest-weighted + most-relevant** memories into context, so the AI focuses on what matters most right now.
- Weights **update as the story develops:**
  - **Reinforced** — a memory referenced again, or tied to an active goal, gains weight.
  - **Decays** — memories untouched for many turns slowly lose weight.
  - **Re-promoted** — a long-dormant fact that suddenly becomes relevant (an old enemy returns) is boosted back up.
  - **Linked** — related memories share weight changes (raising a character's importance raises their associated events).
- Low-weight memories are summarized/compressed rather than dropped, preserving continuity without cost.

This keeps long sessions coherent and affordable: the story remembers what's important and lets trivia fade, just like a human GM.

### 6.3 The "ask the player" rule
A defining design rule: **whenever the story reaches a branch point or needs a decision, the AI stops narrating and asks the player what they want to do** — never deciding the player's actions for them. The AI may narrate the world's actions and NPC behavior, but the player character's choices always belong to the player.

### 6.4 Content & safety
- **Content boundaries are set by default based on the world and story settings.** When a world is created, its genre, tone, and premise automatically establish appropriate boundaries — a cozy fantasy village runs gentle, a gritty noir or war setting allows darker themes, within platform limits.
- The player can review and adjust these defaults, but they don't have to configure anything to start — the setting does the work.
- Guardrails keep generated content within the world's established boundaries and within platform policy at all times.

---

## 7. System architecture (high level)

```
┌──────────────┐     ┌────────────────────┐     ┌──────────────────┐
│   Web client  │◄───►│   Backend / API     │◄───►│   AI model(s)     │
│  (rich UI)    │     │  (game orchestrator)│     │  (LLM + imagery)  │
└──────────────┘     └────────────────────┘     └──────────────────┘
                              │
                              ▼
                     ┌────────────────────┐
                     │   Persistence       │
                     │  - world bible      │
                     │  - memory store     │
                     │  - save states      │
                     └────────────────────┘
```

- **Web client:** renders the story feed and rich UI panels; sends player input, receives narration + state updates.
- **Game orchestrator:** assembles context, calls the AI, runs the state extractor, updates memory, returns the narration and the new world state.
- **AI model(s):** a large language model for narration/NPCs; an image model for optional scene/character art.
- **Persistence:** world bible, structured long-term memory (retrievable), and full save states.

*(Detailed tech stack and data models belong in a separate technical spec — see §10.)*

---

## 8. Differentiation

- **Be anyone:** most AI story games hand you a fixed protagonist; OpenWorld lets you define your role freely.
- **True GM behavior:** the AI runs the world and asks for your choices, rather than auto-playing your character.
- **Persistence & memory:** the world remembers, so long sessions feel coherent rather than amnesiac.
- **Rich but immersive UI:** character sheet, map, and inventory support the fiction without turning it into a spreadsheet.

---

## 9. Success metrics

| Goal | Metric |
|---|---|
| Players get hooked | % of new players who complete 10+ turns in first session |
| Stories feel alive | Avg. turns per session; avg. session length |
| Agency feels real | % of sessions resumed (players come back to their story) |
| Coherence holds | Player-reported "world contradicted itself" rate (low) |
| Retention | D1 / D7 / D30 return rates |

---

## 10. Roadmap

### Phase 1 — MVP (text-first core loop)
- World + role selection (presets and free text), with default content boundaries from the setting.
- Core story loop with "what do you do?" prompts and suggested actions.
- Core mechanics: stats, dice/skill checks, and mental status.
- Loose goals/quests seeding.
- Chapter structure with end-of-chapter recaps (text image placeholder).
- Weighted long-term memory + save/resume.
- Minimal UI: story feed + character sheet + mental status panel.

### Phase 2 — Rich UI
- Map, inventory, relationship tracker, quest/threads panel, world/scene panel.
- End-of-chapter **generated illustrations** + chapter gallery.
- AI-generated scene and character imagery (in-chapter).
- Stronger weighted memory (reinforcement, decay, re-promotion, linking).

### Phase 3 — Depth & polish
- Deeper mental-status modeling and its cascading effects on story.
- Richer NPC autonomy and off-screen world events.
- Tunable difficulty for skill checks; player-adjustable content boundaries.

### Phase 4 — Social / expansion
- Shared worlds, co-op play, or "spectate a friend's story."
- Community-created worlds and roles.
- Mobile clients.

---

## 11. Resolved design decisions

- **Mechanics:** v1 includes stats, dice, and skill checks, plus a **mental status** system for every major character that actively shapes checks, dialogue, and narration (§6A).
- **Structure:** the story is broken into **similar-length chapters**, each ending with a turning point, a recap, and a **generated illustration** (§3.5).
- **Content boundaries:** set **by default from the world/story setting**, adjustable but requiring no setup to start (§6.4).
- **Memory:** long-term memories carry a **weight** that drives retrieval priority and **updates as the story develops** (reinforce / decay / re-promote / link) (§6.5).
- **Direction:** worlds are **seeded with loose goals/quests** that give direction without rails and evolve over time (§3.4).

## 12. Open questions

- Where to draw the line on **AI cost/latency** vs. richness per turn (especially with weighted-memory retrieval + per-chapter image generation)?
- What is the right **chapter length** (turns/beats), and should it adapt to pacing?
- How transparent should **dice rolls and mental-status numbers** be — fully visible, or partly hidden to preserve immersion?
- How are mental-status effects **balanced** so they add tension without frustrating the player?
- What's the **art style/consistency** approach for chapter illustrations (consistent characters across images)?

---

*Next step: a companion **Technical Specification** covering tech stack, data models, memory/retrieval design, prompt templates, and API contracts.*
