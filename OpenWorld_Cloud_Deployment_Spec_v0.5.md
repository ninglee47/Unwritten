# OpenWorld — Cloud Deployment Architecture (v0.5)

**Take the local MVP to a public, multi-user web product on Google Cloud Run.**

| | |
|---|---|
| **Document type** | Deployment / Architecture Specification |
| **Companion to** | `OpenWorld_Technical_Spec_MVP.md`, `OpenWorld_Gemini_Migration_Spec_v0.4.md` (and v0.2/v0.3) |
| **Version** | 0.5 (Draft) |
| **Owner** | Ning |
| **Last updated** | 2026-06-24 |
| **Status** | Draft for review |
| **Decisions locked** | **Audience:** public multi-user product · **Platform:** Google Cloud Run |

---

## 1. Scope

Turn the single-user, filesystem-backed local server into a **stateless, horizontally-scalable web
service** on Cloud Run, with accounts, per-user data isolation, durable managed storage, and
GCP-native AI (pairs with the Gemini migration in v0.4).

The game logic, prompts, schemas, turn pipeline, and mechanics from v0.1–v0.4 **do not change**. What
changes is everything *underneath* them: where state lives, how requests are authenticated, how
background work runs, and how the app is built and shipped.

### The four things that must change (and why)
The local MVP makes three assumptions that a public Cloud Run service breaks:

1. **State lives on the local filesystem** (`data/…` JSON + PNG + PDF). Cloud Run instances are
   **ephemeral and plural** — disk is wiped on each new instance and not shared. → §4 (Firestore +
   GCS).
2. **One long-lived process** holds the image render queue and the per-story turn lock in memory.
   Multiple instances make in-process state wrong. → §6 (Cloud Tasks + lease-based lock).
3. **No auth, single user.** A public product needs accounts and per-user isolation. → §5 (Firebase
   Auth + `ownerId`).
4. **Secrets in `.env`.** → §7 (Secret Manager, or keyless Vertex AI via the service account).

---

## 2. Target architecture

```
                         ┌──────────────────────────────────────────┐
   Browser (SPA) ───────►│  Firebase Hosting (CDN)                   │
   Firebase Auth SDK     │   · static UI assets                      │
        │  ID token       │   · rewrites /api/** ──► Cloud Run        │
        ▼                 └───────────────────┬──────────────────────┘
   ┌─────────────────────────────────────────▼──────────────────────┐
   │                     Cloud Run (stateless, autoscaled)           │
   │   Express app  · verifies Firebase ID token (Admin SDK)         │
   │     Routes ──► Orchestrator (unchanged game logic)              │
   │       ├─ Repo layer (STORAGE_BACKEND=gcp)                       │
   │       ├─ LLM facade (LLM_PROVIDER=vertex|gemini|anthropic)      │
   │       └─ enqueue image jobs ──► Cloud Tasks                     │
   └───┬───────────────┬───────────────┬───────────────┬────────────┘
       │               │               │               │
       ▼               ▼               ▼               ▼
  ┌─────────┐   ┌──────────────┐  ┌──────────┐   ┌──────────────┐
  │Firestore│   │ Cloud Storage│  │Cloud Tasks│   │ Vertex AI /  │
  │ (state) │   │ (images,PDF) │  │  + worker │   │ Gemini 2.5   │
  └─────────┘   └──────────────┘  └─────┬─────┘   └──────────────┘
                                        │ OIDC POST
                                        ▼
                              /internal/render-image (Cloud Run)
                              renders to GCS, updates Firestore doc

  Secret Manager → API keys ·  Cloud Logging/Monitoring → observability
```

| Concern | Local MVP | Cloud (this spec) |
|---|---|---|
| Compute | `node server.js` | Cloud Run container, autoscaled |
| Structured state | JSON files | **Firestore** (Native) |
| Blobs (images, PDFs) | local `.png`/`.pdf` | **Cloud Storage** bucket |
| Background images | in-process queue | **Cloud Tasks** → worker endpoint |
| Turn lock | in-process | Firestore **lease** field |
| Auth | none | **Firebase Auth** ID tokens |
| Secrets | `.env` | **Secret Manager** / keyless **Vertex AI** |
| Static FE | Express static | **Firebase Hosting** (CDN) |
| AI | Anthropic SDK | Vertex AI Gemini (v0.4) |

---

## 3. Design principles

1. **Keep a backend switch, not a fork.** Introduce a **repository layer** with `STORAGE_BACKEND=fs|gcp`
   exactly like the v0.4 `LLM_PROVIDER` switch, so local dev stays file-based and fast while
   production runs on Firestore/GCS. No commented-out code.
2. **The app is stateless.** Any state that outlives a request lives in Firestore/GCS/Cloud Tasks.
   An instance can be killed mid-session with no data loss.
3. **Backend-mediated data access.** Clients never touch Firestore/GCS directly; all access goes
   through the authenticated API (Admin SDK). Firestore security rules default **deny-all** as
   defense in depth.
4. **Game logic untouched.** `orchestrator`, `contextBuilder`, `memory`, `dice`, `chapters`, prompts,
   schemas are unchanged; only their I/O and transport are swapped behind interfaces.

---

## 4. Persistence — Firestore + Cloud Storage

### 4.1 Repository layer (new abstraction)
Replace direct `storage.js` filesystem calls with a repo interface; provide two implementations.
```
src/repo/
  index.js        picks impl by STORAGE_BACKEND (fs | gcp)
  fsRepo.js       the current local filesystem impl (today's storage.js) — dev default
  gcpRepo.js      Firestore (state) + GCS (blobs)
```
Interface (mirrors today's helpers): `worlds.*`, `stories.*`, `characters.*`, `memories.*`,
`chapters.*`, `transcript.append/read`, `blobs.put/getUrl/exists`. Call sites change imports only.

### 4.2 Firestore data model (mirrors the v0.1 folder layout)
```
users/{uid}
worlds/{worldId}                 { ownerId, title, genre, premise, tone, worldBible,
                                   statSchema, background, contentBoundaries, ... }
stories/{storyId}                { ownerId, worldId, title, scene, inventory, goals, chapter,
                                   recentTurns(≤8 inline), turnCount, lock{...}, rev }
  stories/{storyId}/characters/{charId}     player + NPCs (profile, persona, canon, mentalStatus…)
  stories/{storyId}/memories/{memId}        weighted memory items (subcollection)
  stories/{storyId}/turns/{index}           full transcript, one doc per turn
  stories/{storyId}/chapters/{n}            chapter records (imagePath → GCS, status)
```
- **Why subcollections for turns/memories/characters:** Firestore caps a doc at **1 MB**; transcripts
  and memory grow unbounded, so they can't be one document. `recentTurns` stays inline on the story
  doc (windowed to 8) for fast per-turn context; the full log is the `turns` subcollection.
- `ownerId` on every top-level doc; all queries filtered by it.
- Memory retrieval still loads a story's memory items and filters in-process (small scale; matches
  Tech Spec §8 — no query-engine change needed).

### 4.3 Cloud Storage (blobs)
- Bucket layout mirrors paths: `stories/{storyId}/chapters/{n}.png`,
  `stories/{storyId}/characters/{charId}.png` (portraits), `stories/{storyId}/scenes/{turn}.png`,
  `stories/{storyId}/exports/*.pdf`.
- Served via **signed URLs** (short-lived) or proxied through the app's existing image/export routes
  (which already content-sniff and stream). Keep the route shape from v0.1/v0.3; only the source
  becomes GCS. Ebook PDFKit streams to GCS instead of local disk.
- Per-owner path prefixing + bucket IAM; no public objects by default.

### 4.4 Data migration
A one-off script walks local `data/` → writes Firestore docs + uploads blobs to GCS (assign `ownerId`
to a seed account). Low volume (dev saves).

---

## 5. Auth & multi-tenancy

- **Firebase Authentication** (Identity Platform): email/password + Google sign-in. Client gets an
  **ID token (JWT)**; sends it as `Authorization: Bearer <token>`.
- **Backend middleware** verifies the token with the Firebase Admin SDK → `req.uid`. All routes
  require it (except health check + static).
- **Ownership:** every world/story carries `ownerId = uid`. Every route loads the doc and **rejects
  if `ownerId !== req.uid`** (404, not 403, to avoid leaking existence). List endpoints filter by
  `ownerId`.
- **Firestore security rules: deny-all to clients.** Since access is backend-only via Admin SDK
  (which bypasses rules), lock client access entirely — defense in depth against any future direct
  SDK use.
- **New routes:** none required for auth itself (Firebase handles it); add `GET /api/me` for the
  client to confirm session.

---

## 6. Statelessness — distributed lock + job queue

### 6.1 Per-story turn lock (replaces the in-process lock, v0.2 §3.8)
A turn does a long AI call, which can't sit inside a Firestore transaction. Use a **lease**:
1. In a quick Firestore transaction: read `story.lock`. If `lock.active && lock.expires > now` →
   reject the new turn with **409 "turn in progress."** Else set
   `lock = { active: true, expires: now + 120s, instanceId }` and commit.
2. Run the (long) turn pipeline.
3. Persist results and clear the lock. Use a `rev` (monotonic) field for optimistic concurrency on
   the final write so a stale instance can't clobber newer state.
A stale lease (crashed instance) auto-expires, so stories never wedge.

### 6.2 Image generation (replaces in-process `imageQueue.js`, v0.3 §4)
- The turn/chapter path **enqueues a Cloud Task** (`render-image` with `{storyId, kind, id, prompt}`)
  instead of running an in-process job.
- A **worker endpoint** `POST /internal/render-image` (callable **only** by the queue's service
  account via OIDC) renders through `images.js` (Gemini) to GCS, then updates the chapter/turn/
  character doc with `imagePath` + `status: ready|failed`.
- The client keeps the v0.3 §4 behavior: shows a "generating…" placeholder and polls
  `GET …/image/:n/status` (now reading Firestore). 429s are handled by Cloud Tasks **retry/backoff
  config** + the provider classifier — never surfaced, never blocking.
- This makes image generation fully stateless and decoupled from request lifetime.

---

## 7. AI on GCP (ties to v0.4)

- Prefer **Vertex AI Gemini** so Cloud Run authenticates with its **service account — no API key to
  store**. Add `vertex` as an `LLM_PROVIDER`/image option alongside the v0.4 `gemini` (AI Studio key)
  path; both wrap the same `llm.js` facade.
- If staying on the AI Studio key, store `GEMINI_API_KEY` in **Secret Manager** and mount it as a
  Cloud Run secret env var (never in the image).
- Keep Anthropic as the live fallback (v0.4): its key likewise via Secret Manager.
- Safety settings (v0.4 §4.6) matter more in a public product — keep the game's content boundaries as
  the primary gate, within Google policy.

---

## 8. Long requests, streaming, concurrency

- **Request timeout:** set Cloud Run timeout generously (e.g. 300 s) so a synchronous turn fits;
  Cloud Run allows up to 60 min if needed.
- **Concurrency:** a turn is CPU-light but holds the request open during a long AI call. Set per-
  instance `--concurrency` moderate (e.g. 8–20) and let Cloud Run **scale out** rather than packing
  too many long requests per instance. Tune `--cpu`/`--memory` (start 1 vCPU / 512 MB–1 GB).
- **Min instances:** `min-instances=1` avoids cold-start latency on the AI path (cost vs UX tradeoff —
  see open questions); `max-instances` caps spend.
- **Streaming (recommended next):** stream narration via SSE for responsiveness on long turns; parse
  the trailing JSON when the stream completes (Tech Spec §10 notes streaming as optional). Not
  required for launch but high-value UX.

---

## 9. Frontend hosting

- **Firebase Hosting** serves the SPA + static assets over CDN, with a **rewrite** of `/api/**` to the
  Cloud Run service (and `/internal/**` left unexposed). Custom domain + TLS handled by Hosting.
- Add the **auth UI** (login/signup via Firebase Auth SDK) ahead of the existing onboarding; attach
  the ID token to every `fetch` in `public/app.js`.
- Alternative (simpler, no CDN): serve static straight from Cloud Run as today — acceptable for an
  early launch, but Hosting is the better public-product default.

---

## 10. Cost, rate limiting & abuse (public-product essentials)

- **AI cost is user-driven and dominates.** Enforce **per-user rate limits** (turns/min) and a
  **daily token/credit budget**; return a friendly "daily limit reached" rather than unbounded spend.
- **Spend guardrails:** `max-instances` cap, GCP **budget alerts**, and per-user quota in Firestore.
- **Abuse:** input length caps (lower the current `express.json({limit})`), basic prompt-injection
  hygiene, Gemini safety settings, and reCAPTCHA/email-verify on signup.
- **Open model question:** platform-paid AI (you eat the cost, hard quotas) vs **bring-your-own-key**
  per user (shifts cost, simplifies abuse) — see §17.

---

## 11. Build & deploy

- **Containerize:** `Dockerfile` (`node:20-slim`, `npm ci --omit=dev`, copy app, `CMD ["node","server.js"]`),
  `.dockerignore` (exclude `data/`, `.env`, `node_modules`).
- **Deploy:** `gcloud run deploy --source .` (Cloud Build builds the image) or a Cloud Build pipeline.
- **CI:** the repo currently has **no git** — initialize a repo, push to GitHub/Cloud Source, and add
  a Cloud Build trigger on `main` → deploy to Cloud Run.
- **Service account & IAM:** Cloud Run SA needs roles for Firestore, GCS (object admin on the
  bucket), Cloud Tasks (enqueuer), Secret Manager (accessor), and Vertex AI (user).
- **Regions:** colocate Cloud Run + Firestore + GCS + Vertex in one region near target users.

---

## 12. Observability
- Cloud Run ships logs/metrics to **Cloud Logging/Monitoring** automatically; emit **structured JSON
  logs** (turn id, story id, uid, latency, token usage, provider).
- **Error Reporting** for exceptions; **uptime checks** + alerts on error rate / latency / 5xx.
- Track per-turn AI latency and cost to inform the rate-limit/quota tuning in §10.

---

## 13. Config / env delta (Cloud Run)
```
STORAGE_BACKEND=gcp                 # fs (local dev) | gcp
GCP_PROJECT=...
GCS_BUCKET=openworld-...            # blobs
FIRESTORE_DATABASE=(default)
CLOUD_TASKS_QUEUE=render-image
CLOUD_TASKS_LOCATION=us-central1
RENDER_WORKER_URL=https://<run-url>/internal/render-image

LLM_PROVIDER=vertex                 # vertex | gemini | anthropic   (v0.4)
IMAGE_PROVIDER=gemini               # via Vertex or AI Studio key
GEMINI_MODEL=gemini-2.5-flash
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image

# secrets (Secret Manager → Cloud Run secret env), only if not using Vertex SA:
# GEMINI_API_KEY, ANTHROPIC_API_KEY

# Firebase Auth
FIREBASE_PROJECT_ID=...
# limits
USER_TURNS_PER_MIN=10
USER_DAILY_TOKEN_BUDGET=...
```
Local dev keeps `STORAGE_BACKEND=fs` + `.env` — zero cloud dependencies to run the game locally.

---

## 14. Files: new / changed
```
src/repo/index.js, fsRepo.js, gcpRepo.js   NEW — storage abstraction (§4)
src/auth.js                                NEW — Firebase token verify middleware + ownership guard (§5)
src/lock.js                                NEW — Firestore lease lock (§6.1)
src/tasks.js                               NEW — enqueue Cloud Tasks render jobs (§6.2)
server.js                                  CHANGE — auth middleware, ownerId on create, /internal route,
                                                    /api/me, blobs via repo, lower body limit
src/orchestrator.js                        CHANGE — acquire/release lease; persist via repo; enqueue images
src/storage.js                             BECOMES fsRepo (kept as the local backend)
src/ebook.js, src/images.js                CHANGE — write/read blobs via repo (GCS), not local fs
public/app.js, index.html                  CHANGE — Firebase Auth UI + attach ID token to fetches
Dockerfile, .dockerignore                  NEW
cloudbuild.yaml (or --source)              NEW — build/deploy
firebase.json                              NEW — Hosting + rewrite /api/** → Cloud Run
scripts/migrate-local-to-gcp.js            NEW — one-off data import (§4.4)
```

## 15. Migration & rollout plan (phased)
1. **Repo abstraction** — extract the interface, keep `fsRepo` (today's behavior). No functional
   change; verify locally.
2. **`gcpRepo`** — Firestore + GCS impl; test against the **Firestore emulator** + a dev bucket;
   flip `STORAGE_BACKEND=gcp` locally.
3. **Auth** — Firebase Auth + middleware + `ownerId` + ownership checks; client login UI.
4. **Stateless concurrency** — lease lock + Cloud Tasks image worker; remove in-process queue/lock.
5. **AI on GCP** — Vertex AI provider (or key via Secret Manager).
6. **Ship** — Dockerfile → Cloud Run; Firebase Hosting for the SPA; custom domain.
7. **Harden** — rate limits, budgets, monitoring/alerts, abuse controls; then launch.

## 16. Acceptance criteria
- **Stateless:** killing/replacing a Cloud Run instance mid-session loses no data; resume works.
- **Isolation:** two signed-in users never see each other's worlds/stories; a cross-owner id returns
  404.
- **Concurrency:** two simultaneous turns on one story → exactly one runs, the other gets 409; no
  state corruption (rev guard holds).
- **Images:** chapter/portrait/scene render via Cloud Tasks to GCS and appear via the client poll; a
  provider 429 never surfaces or blocks (Cloud Tasks retries).
- **Secrets:** no API key in the image or repo; Vertex uses the SA, or keys come from Secret Manager.
- **Local dev unaffected:** `STORAGE_BACKEND=fs` + `LLM_PROVIDER=anthropic|gemini` runs the full game
  with no GCP services.
- **Cost guardrails:** a user exceeding the per-day budget is throttled gracefully; budget alerts fire.

## 17. Open questions
- **Firestore vs Cloud SQL (Postgres):** the data is document-shaped and per-user, so **Firestore**
  fits with the least reshaping and no connection-pool pain on serverless — but if we later want
  cross-story analytics/SQL, Postgres may be worth it. Default: Firestore.
- **Vertex AI vs AI Studio key:** keyless SA (Vertex) is the cleaner production posture; AI Studio key
  is simpler to start. Default: Vertex for prod, key for local.
- **min-instances:** `1` (no cold starts, steady cost) vs `0` (cheaper, cold-start latency on the AI
  path). Default: `1` at launch, revisit on traffic.
- **AI cost model:** platform-paid with hard quotas vs **bring-your-own-key** per user. Big product
  decision — affects pricing, abuse surface, and signup friction.
- **Worlds as shareable templates?** Keep worlds strictly per-owner, or allow public/shared world
  templates that seed many users' stories (changes the `ownerId` model for `worlds`).
- **Streaming (SSE) at launch or after?** High UX value on long turns; modest added complexity.
```
