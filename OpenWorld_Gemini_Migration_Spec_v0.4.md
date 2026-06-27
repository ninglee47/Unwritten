# OpenWorld — Gemini Provider Migration (v0.4)

**Switch story + image generation to Google Gemini 2.5 Flash, behind a runtime provider switch (Claude kept live as fallback).**

| | |
|---|---|
| **Document type** | Migration / Delta Specification |
| **Companion to** | `OpenWorld_Technical_Spec_MVP.md`, `OpenWorld_Enhancements_Spec_v0.2.md`, `OpenWorld_Fixes_Improvements_v0.3.md` |
| **Version** | 0.4 (Draft) |
| **Owner** | Ning |
| **Last updated** | 2026-06-24 |
| **Status** | Draft for review |

---

## 1. Goal & scope

Move all generation to **Google Gemini 2.5 Flash**:
- **Story / text** (GM narration, world‑gen, opening, chapter recap, dice pre‑check classification) →
  `gemini-2.5-flash`.
- **Images** (chapter, portrait, scene/action) → `gemini-2.5-flash-image`.

**Do it behind a runtime provider switch, not by commenting out the Claude path.** The Anthropic
implementation stays in the tree as a live, env‑selectable fallback. Rationale:

- Commented‑out code goes stale against the evolving schemas, is never exercised, and can't be
  hot‑swapped if Gemini disappoints on quality, JSON adherence, or rate limits.
- **This repo has no git history**, so the Claude path would otherwise have no backup at all — keeping
  it as a live adapter *is* the backup.
- The image layer is **already** a pluggable, env‑keyed adapter (`IMAGE_PROVIDER`) with a Gemini
  option — so we extend an existing pattern rather than inventing one.

**Out of scope:** changing game logic, prompts' *content* (only their output‑format glue may change),
data models, or the turn pipeline. This is an integration‑layer change only.

---

## 2. Design principles

1. **Provider abstraction, not deletion.** Introduce a thin LLM facade selected by `LLM_PROVIDER`;
   each provider is a small module implementing one low‑level "generate text" call.
2. **Keep the provider‑agnostic value in one place.** The structured‑output pipeline that the whole
   game depends on — JSON extraction (`extractJSON`), repair (`sanitizeJSON`), `zod` validation, and
   the self‑correcting retry in `callGMStructured` — is **not** Anthropic‑specific and must be shared,
   not duplicated per provider.
3. **Call sites don't change.** `orchestrator.js`, `worldGen.js`, `chapters.js`, and `dice.js` keep
   calling `callGM` / `callClassify` / `callGMStructured` exactly as today; only the import source
   and the low‑level transport change.
4. **Both paths stay runnable.** Flip `LLM_PROVIDER` / `IMAGE_PROVIDER` to roll back instantly; both
   adapters remain compiled and exercised.

---

## 3. Target models

| Use | Model id | Notes |
|---|---|---|
| GM narration, world‑gen, opening, recap | `gemini-2.5-flash` | Configurable via `GEMINI_MODEL`. |
| Dice pre‑check (cheap classifier) | `gemini-2.5-flash-lite` | The Haiku analogue; `GEMINI_CLASSIFY_MODEL`. |
| Images (chapter/portrait/scene) | `gemini-2.5-flash-image` | ⚠️ **Not** plain `gemini-2.5-flash` — that returns text. `-preview` suffix if GA isn't enabled on the key. `GEMINI_IMAGE_MODEL`. |

> Google rotates these model names; every id above is overridable via env. The existing image adapter
> already does this (`GEMINI_IMAGE_MODEL`) with a code comment to that effect.

---

## 4. Text migration

### 4.1 Current state
`src/claude.js` is the single text seam. It exposes `callGM(system, messages, max_tokens)`,
`callClassify(system, userText, max_tokens)`, `callGMStructured(system, messages, schema, max_tokens)`,
plus the shared helpers `extractJSON` / `sanitizeJSON`, and (per v0.2 §11) error classification +
backoff. All text call sites import from it.

### 4.2 Target structure — a provider facade
```
src/
  llm.js                  NEW — facade: callGM / callClassify / callGMStructured + shared
                          JSON pipeline (extractJSON, sanitizeJSON, validate, self-correcting retry,
                          backoff). Dispatches the low-level generate() by LLM_PROVIDER.
  providers/
    anthropic.js          MOVED from claude.js — low-level generate({system,messages,maxTokens,json})
                          + classifyError(). (Keeps the existing Anthropic transport intact.)
    gemini.js             NEW — same interface, Gemini transport + role/system mapping + classifyError().
```
- `llm.js` owns everything provider‑agnostic (the structured pipeline + retry loop). Each provider
  module implements only:
  ```js
  // returns concatenated text of the model's reply
  async function generate({ system, messages, maxTokens, json }) { ... }
  function classifyError(err) { /* → 'transient' | 'rate_limit' | 'credit' | 'fatal' */ }
  ```
- Call sites change their import from `./claude.js` to `./llm.js`; function names are identical, so
  no other edits. (Optionally keep `claude.js` as a thin re‑export of `providers/anthropic.js` for
  zero churn.)

### 4.3 API mapping (Anthropic → Gemini)
| Concern | Anthropic | Gemini (`generateContent`) |
|---|---|---|
| Transport | `@anthropic-ai/sdk` | `@google/genai` SDK **or** REST `…/v1beta/models/{model}:generateContent?key=` |
| System prompt | top‑level `system` | `systemInstruction: { parts: [{ text }] }` |
| Messages | `messages: [{ role: 'user'\|'assistant', content }]` | `contents: [{ role: 'user'\|'model', parts: [{ text }] }]` |
| Max tokens | `max_tokens` | `generationConfig.maxOutputTokens` |
| Reply text | `res.content[].text` | `res.candidates[0].content.parts[].text` (concatenate) |
| JSON output | prompt‑only ("emit one json block") | `generationConfig.responseMimeType: "application/json"` (optionally `responseSchema`) |
| Rate‑limit error | HTTP 429 | HTTP 429 `RESOURCE_EXHAUSTED` |
| Safety | minimal | `safetySettings[]` thresholds (see §4.6) |
| "Thinking" | n/a | `generationConfig.thinkingConfig.thinkingBudget` (see §4.7) |

Key adapter responsibilities in `gemini.js`:
- Map `assistant` → `model`; keep the existing rule that the first message must be `user` (already
  enforced in `contextBuilder.js`).
- Concatenate all text parts of `candidates[0]`.
- Translate `max_tokens` → `maxOutputTokens`.

### 4.4 Structured output (the critical part)
The turn pipeline depends on a parseable deltas object. Two layers, belt‑and‑suspenders:
1. **Native JSON mode (recommended):** set `responseMimeType: "application/json"` for the structured
   calls (`callGMStructured`). Gemini then returns JSON text directly, which is more reliable than
   prompt‑only fencing.
2. **Keep the existing safety net:** `extractJSON` + `sanitizeJSON` + `zod` validation + the
   self‑correcting retry stay in `llm.js` and run regardless of provider. The system prompt's "emit
   one ```json block" instruction still works (Gemini's JSON mode returns a bare object; `extractJSON`
   already handles both fenced and bare objects).
- **`responseSchema` is optional and deferred:** the deltas schema uses unions/records that don't map
  cleanly to Gemini's OpenAPI‑subset schema. Start with `responseMimeType` only; consider a
  hand‑written `responseSchema` for the simplest calls (e.g. the dice pre‑check) later.

### 4.5 Error handling & retry
Generalize the v0.2 §11 retry so it's provider‑neutral: `llm.js` runs the backoff loop and asks the
active provider's `classifyError(err)` to bucket failures into `transient | rate_limit | credit |
fatal`. Gemini mapping:
- `429 / RESOURCE_EXHAUSTED` → `rate_limit` (honor any `retryDelay` in the error details).
- `500 / 503 (UNAVAILABLE)` / network / timeout → `transient`.
- Quota/billing exhaustion → `credit` (longer bounded retry).
- `400 INVALID_ARGUMENT` / auth (`401/403`) → `fatal` (fail fast).

### 4.6 Safety settings (migration gotcha)
Gemini applies its own content filters (`HARM_CATEGORY_*`). For worlds whose `contentBoundaries`
allow violence/grit (dark fantasy, noir, war), default thresholds may **block** legitimate narration.
The adapter should set `safetySettings` to a permissive‑but‑policy‑bound threshold (e.g.
`BLOCK_ONLY_HIGH`) so the game's own boundary system (Product Spec §6.4) remains the primary gate,
within Google's platform policy. Make the threshold configurable (`GEMINI_SAFETY=default|relaxed`).

### 4.7 Latency/quality knobs
- `gemini-2.5-flash` is a "thinking" model. Leaving thinking on improves narration coherence but adds
  latency/cost; `thinkingConfig.thinkingBudget: 0` disables it for speed. Expose
  `GEMINI_THINKING=on|off` (default `on` for the GM, `off` for the cheap classifier).
- Optional `temperature` per call type (slightly higher for narration, low for classification).

---

## 5. Image migration (trivial — no code restructuring)

`src/images.js` is already an `IMAGE_PROVIDER`‑keyed adapter and **already has a `gemini` case** that
calls `…:generateContent` with `responseModalities: ["TEXT","IMAGE"]` and supports reference images
(v0.2 §8). To switch:

1. `IMAGE_PROVIDER=gemini` in `.env`.
2. Bump the model: `GEMINI_IMAGE_MODEL=gemini-2.5-flash-image` (the current default is the old
   `gemini-2.0-flash-preview-image-generation`).
3. Nothing to comment out — pollinations/cloudflare/huggingface adapters stay behind the switch.

This also folds into the v0.3 §4 image queue: Gemini 429s flow through the same rate‑limit‑aware
retry + "generating…" placeholder, so a rate‑limited image never blocks or surfaces an error.

> One key (`GEMINI_API_KEY`) serves both text and images.

---

## 6. Configuration (`.env`) delta
```
# ── Provider switch ───────────────────────────────
LLM_PROVIDER=gemini            # gemini | anthropic   (text path)
IMAGE_PROVIDER=gemini          # gemini | none | pollinations | cloudflare | huggingface

# ── Gemini ────────────────────────────────────────
GEMINI_API_KEY=...             # used by BOTH text and images
GEMINI_MODEL=gemini-2.5-flash
GEMINI_CLASSIFY_MODEL=gemini-2.5-flash-lite
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
GEMINI_SAFETY=relaxed          # default | relaxed   (within platform policy)
GEMINI_THINKING=on             # on | off

# ── Anthropic (kept as live fallback) ─────────────
ANTHROPIC_API_KEY=sk-ant-...
MODEL=claude-sonnet-4-6
CLASSIFY_MODEL=claude-haiku-4-5-20251001
```
The existing v0.2/v0.3 retry + image‑queue keys (`CLAUDE_MAX_RETRIES`, `IMAGE_CONCURRENCY`, …) are
reused/renamed to be provider‑neutral where they leak the word "claude" (e.g. `LLM_MAX_RETRIES`).

---

## 7. Dependencies
- Add **`@google/genai`** (the current unified Google Gen AI SDK). *Alternative:* raw REST `fetch`
  (no new dependency, consistent with how `images.js` already calls Gemini) — acceptable if we want
  to keep the dep list minimal; the SDK mainly buys cleaner structured‑output + streaming ergonomics.
- Keep `@anthropic-ai/sdk` (fallback path).

---

## 8. Files: new / changed
```
src/llm.js               NEW — provider facade + shared structured pipeline + backoff dispatch (§4.2)
src/providers/anthropic.js  MOVED from claude.js (transport + classifyError); claude.js may re-export
src/providers/gemini.js  NEW — Gemini transport, role/system mapping, JSON mode, safety, classifyError
src/images.js            CHANGE: bump GEMINI_IMAGE_MODEL default to gemini-2.5-flash-image (§5)
src/orchestrator.js      CHANGE: import LLM fns from ./llm.js  (names unchanged)
src/worldGen.js          CHANGE: import from ./llm.js
src/chapters.js          CHANGE: import from ./llm.js
src/dice.js              CHANGE: import from ./llm.js
.env.example / README    CHANGE: document LLM_PROVIDER + Gemini keys (§6)
package.json             CHANGE: add @google/genai (unless going REST-only)
prompts/*                NO content change; JSON-mode means the "only a json block" instruction is
                         still honored and parsed by the shared pipeline.
```

## 9. Cutover & rollback
1. Land the `llm.js` facade with **`LLM_PROVIDER=anthropic`** first → behavior identical to today
   (pure refactor; verify a full turn + world‑gen + chapter close still pass).
2. Implement `gemini.js`; flip `LLM_PROVIDER=gemini` in a scratch `.env`; smoke‑test world‑gen →
   opening → several turns → a chapter close (recap + image) → ebook export.
3. Flip `IMAGE_PROVIDER=gemini`, set `GEMINI_IMAGE_MODEL`; verify chapter/portrait/scene images.
4. **Rollback** = set `LLM_PROVIDER=anthropic` / `IMAGE_PROVIDER=<prev>`; no code change.

## 10. Risks & mitigations
| Risk | Mitigation |
|---|---|
| JSON adherence differs from Claude | Native `responseMimeType: application/json` + keep `extractJSON`/`sanitize`/retry. |
| Safety filters block gritty (but in‑boundary) narration | `safetySettings` `BLOCK_ONLY_HIGH` via `GEMINI_SAFETY`; game boundaries remain primary gate. |
| Narration quality vs Claude (subjective) | A/B by flipping `LLM_PROVIDER`; keep Claude live. |
| Thinking‑mode latency/cost | `GEMINI_THINKING=off` for classifier; tune for GM. |
| Free‑tier rate limits (429) | provider‑neutral rate‑limit retry (§4.5) + v0.3 §4 image queue. |
| Model‑name rotation | every model id is env‑overridable. |
| Image model confusion | doc + default explicitly call out `gemini-2.5-flash-image` ≠ `gemini-2.5-flash`. |

## 11. Acceptance criteria
- With `LLM_PROVIDER=gemini`, a full session (world‑gen → opening → ≥10 turns → chapter close →
  ebook) runs with valid structured deltas every turn and no schema‑parse failures beyond the normal
  one‑retry path.
- With `IMAGE_PROVIDER=gemini` + `GEMINI_IMAGE_MODEL=gemini-2.5-flash-image`, chapter/portrait/scene
  images render (and 429s degrade to the "generating…" state per v0.3 §4, never an error).
- Setting `LLM_PROVIDER=anthropic` reproduces today's behavior with **no code change** — proving the
  fallback is live, not commented out.
- Call sites (`orchestrator`/`worldGen`/`chapters`/`dice`) are unchanged except their import path.
- A gritty in‑boundary world narrates without spurious safety blocks under `GEMINI_SAFETY=relaxed`.

## 12. Open questions
- **SDK vs REST** for the text path: adopt `@google/genai` (cleaner structured output/streaming) or
  stay REST‑only to avoid a new dependency (matches current `images.js`)?
- **Single provider or per‑call?** Worth allowing, e.g., Gemini for narration but the cheap classifier
  on whichever is cheaper — or keep one `LLM_PROVIDER` for all text (simpler)?
- **`responseSchema`:** adopt Gemini's native schema for the simplest calls (dice pre‑check) now, or
  rely solely on `responseMimeType` + the existing validator?
- **Retire Claude eventually?** If Gemini proves out, do we keep Anthropic as a permanent fallback or
  remove it after a bake‑in period?
