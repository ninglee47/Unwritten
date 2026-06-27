// server.js — Express entry point. Serves the UI + JSON API (Technical Spec §11).
import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import {
  paths,
  readJSON,
  writeJSON,
  exists,
  listDirs,
  ensureDir,
} from "./src/storage.js";
import { createWorld, startStory, loadWorld } from "./src/worldGen.js";
import { runTurn, loadBundle, deriveUIState } from "./src/orchestrator.js";
import { listChapters } from "./src/chapters.js";
import { exportEbook } from "./src/ebook.js";
import { enqueueImage, imageStatus } from "./src/imageQueue.js";
import { composePortraitPrompt } from "./src/imagePrompt.js";
import {
  placeholderSVG,
  portraitPlaceholderSVG,
  generatingSVG,
  unavailableSVG,
} from "./src/placeholder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ensure base data dirs exist
ensureDir(paths.worlds());
ensureDir(paths.stories());

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    // Retryable (rate-limit / credit exhaustion after the backoff budget) →
    // 503 with a flag so the client can offer a Retry (v0.2 §11.3).
    if (err.retryable) {
      return res.status(503).json({
        error: err.message || "temporarily unavailable",
        retryable: true,
        reason: err.reason || "transient",
      });
    }
    res.status(500).json({ error: err.message || "internal error" });
  });

// ---- Worlds ----------------------------------------------------------------
app.post(
  "/api/world",
  wrap(async (req, res) => {
    const premise = (req.body?.premise || "").trim();
    if (!premise) return res.status(400).json({ error: "premise is required" });
    const world = await createWorld(premise);
    res.json(world);
  })
);

app.get(
  "/api/worlds",
  wrap(async (_req, res) => {
    const worlds = listDirs(paths.worlds())
      .filter((id) => exists(paths.worldFile(id)))
      .map((id) => {
        const w = readJSON(paths.worldFile(id));
        return {
          worldId: w.worldId,
          title: w.title,
          genre: w.genre,
          premise: w.premise,
          tone: w.tone,
          statSchema: w.statSchema,
          roleSuggestions: w.roleSuggestions,
        };
      });
    res.json({ worlds });
  })
);

app.get(
  "/api/world/:worldId",
  wrap(async (req, res) => {
    if (!exists(paths.worldFile(req.params.worldId)))
      return res.status(404).json({ error: "world not found" });
    res.json(loadWorld(req.params.worldId));
  })
);

// ---- Stories ---------------------------------------------------------------
app.post(
  "/api/story",
  wrap(async (req, res) => {
    const { worldId, role, playerName } = req.body || {};
    if (!worldId || !role)
      return res.status(400).json({ error: "worldId and role are required" });
    if (!exists(paths.worldFile(worldId)))
      return res.status(404).json({ error: "world not found" });
    const { story, player } = await startStory(worldId, role, playerName);
    const characters = new Map([[player.id, player]]);
    res.json({
      storyId: story.storyId,
      opening: story.recentTurns[0],
      state: deriveUIState(story, characters),
    });
  })
);

app.get(
  "/api/stories",
  wrap(async (_req, res) => {
    const stories = listDirs(paths.stories())
      .filter((id) => exists(paths.storyFile(id)))
      .map((id) => {
        const s = readJSON(paths.storyFile(id));
        return {
          storyId: s.storyId,
          worldId: s.worldId,
          title: s.title,
          updatedAt: s.updatedAt,
          turnCount: s.turnCount,
          chapter: s.chapter?.index,
        };
      })
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    res.json({ stories });
  })
);

app.get(
  "/api/story/:storyId",
  wrap(async (req, res) => {
    const { storyId } = req.params;
    if (!exists(paths.storyFile(storyId)))
      return res.status(404).json({ error: "story not found" });
    const { story, characters, world } = loadBundle(storyId);
    res.json({
      storyId,
      worldId: story.worldId,
      world: {
        title: world.title,
        genre: world.genre,
        tone: world.tone,
        premise: world.premise,
        background: world.background || null,
      },
      state: deriveUIState(story, characters),
      recentTurns: story.recentTurns,
      // "story so far" recap = latest chapter recaps + current scene summary
      storySoFar: buildStorySoFar(storyId, story),
    });
  })
);

// One turn at a time per story — a turn loads → mutates → rewrites the whole
// save, so overlapping turns for the same story could clobber each other.
const _turnsInFlight = new Set();

app.post(
  "/api/story/:storyId/turn",
  wrap(async (req, res) => {
    const { storyId } = req.params;
    const input = (req.body?.input || "").trim();
    if (!exists(paths.storyFile(storyId)))
      return res.status(404).json({ error: "story not found" });
    if (!input) return res.status(400).json({ error: "input is required" });
    if (_turnsInFlight.has(storyId))
      return res.status(409).json({ error: "a turn is already in progress for this story" });
    _turnsInFlight.add(storyId);
    try {
      const result = await runTurn(storyId, input);
      res.json(result);
    } finally {
      _turnsInFlight.delete(storyId);
    }
  })
);

app.get(
  "/api/story/:storyId/chapters",
  wrap(async (req, res) => {
    const { storyId } = req.params;
    if (!exists(paths.storyFile(storyId)))
      return res.status(404).json({ error: "story not found" });
    res.json({ chapters: listChapters(storyId) });
  })
);

// Serve an image file with a content-type sniffed from its magic bytes.
function sendImageFile(res, file) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const hex = head.toString("hex");
  if (hex.startsWith("ffd8ff")) res.type("jpeg");
  else if (hex === "89504e47") res.type("png");
  else res.type("png");
  fs.createReadStream(file).pipe(res);
}

// Serve a ready image, else enqueue a background render and return a
// "generating" placeholder immediately — never blocks, never surfaces a 429
// (v0.3 §4.3). `nonePlaceholder()` is used when no provider is configured.
function respondImage(res, { key, file, prompt, referenceImages = [], onReady, label, nonePlaceholder }) {
  if (exists(file)) return sendImageFile(res, file);
  res.set("Cache-Control", "no-store");
  const provider = (process.env.IMAGE_PROVIDER || "none").toLowerCase();
  if (provider !== "none" && prompt) {
    const status = enqueueImage(key, { prompt, outPath: file, referenceImages, onReady });
    res.set("X-Image-Status", status);
    return res.type("svg").send(status === "failed" ? unavailableSVG(label) : generatingSVG(label));
  }
  res.set("X-Image-Status", "absent");
  return res.type("svg").send(nonePlaceholder ? nonePlaceholder() : placeholderSVG(label || "Illustration"));
}

// Cheap status check (no image bytes) so the client can poll while generating.
function imageStatusResponse(res, file, key) {
  if (exists(file)) return res.json({ status: "ready" });
  res.json({ status: imageStatus(key) });
}

// ---- Chapter images -------------------------------------------------------
app.get(
  "/api/story/:storyId/image/:n",
  wrap(async (req, res) => {
    const { storyId, n } = req.params;
    const file = paths.chapterImage(storyId, n);
    let label = `Chapter ${n}`;
    let prompt = null;
    let refs = [];
    if (exists(paths.chapterFile(storyId, n))) {
      const ch = readJSON(paths.chapterFile(storyId, n));
      label = ch.title || label;
      prompt = ch.imagePrompt;
      refs = (ch.referenceCharacterIds || [])
        .map((id) => paths.portrait(storyId, id))
        .filter((p) => exists(p));
    }
    respondImage(res, {
      key: `chapter:${storyId}:${n}`,
      file,
      prompt,
      referenceImages: refs,
      label,
      onReady: () => {
        if (!exists(paths.chapterFile(storyId, n))) return;
        const ch = readJSON(paths.chapterFile(storyId, n));
        ch.imagePath = paths.chapterImageRel(storyId, n);
        writeJSON(paths.chapterFile(storyId, n), ch);
      },
    });
  })
);
app.get(
  "/api/story/:storyId/image/:n/status",
  wrap(async (req, res) =>
    imageStatusResponse(res, paths.chapterImage(req.params.storyId, req.params.n), `chapter:${req.params.storyId}:${req.params.n}`)
  )
);

// ---- Character portraits (v0.2 §7) ----------------------------------------
function portraitPrompt(storyId, char) {
  if (!char?.visualDescriptor) return null;
  const story = readJSON(paths.storyFile(storyId));
  const world = loadWorld(story.worldId);
  return composePortraitPrompt({ world, character: char });
}
app.get(
  "/api/story/:storyId/portrait/:characterId",
  wrap(async (req, res) => {
    const { storyId, characterId } = req.params;
    const file = paths.portrait(storyId, characterId);
    const charFile =
      characterId === "player" ? paths.playerFile(storyId) : paths.npcFile(storyId, characterId);
    const char = exists(charFile) ? readJSON(charFile) : null;
    respondImage(res, {
      key: `portrait:${storyId}:${characterId}`,
      file,
      prompt: char ? portraitPrompt(storyId, char) : null,
      label: char?.displayName || char?.name || characterId,
      nonePlaceholder: () =>
        portraitPlaceholderSVG(char?.displayName || char?.name || characterId, char?.visualDescriptor || ""),
      onReady: () => {
        if (!exists(charFile)) return;
        const c = readJSON(charFile);
        c.portraitPath = paths.portraitRel(storyId, characterId);
        writeJSON(charFile, c);
      },
    });
  })
);
app.get(
  "/api/story/:storyId/portrait/:characterId/status",
  wrap(async (req, res) =>
    imageStatusResponse(
      res,
      paths.portrait(req.params.storyId, req.params.characterId),
      `portrait:${req.params.storyId}:${req.params.characterId}`
    )
  )
);

// ---- In-chapter scene/action images (v0.2 §9) -----------------------------
app.get(
  "/api/story/:storyId/scene/:turnIndex",
  wrap(async (req, res) => {
    const { storyId, turnIndex } = req.params;
    const file = paths.sceneImage(storyId, turnIndex);
    const turn = findTurn(storyId, Number(turnIndex));
    respondImage(res, {
      key: `scene:${storyId}:${turnIndex}`,
      file,
      prompt: turn?.sceneImage?.prompt || null,
      label: turn?.sceneImage?.kind === "action" ? "Action" : "Scene",
    });
  })
);
app.get(
  "/api/story/:storyId/scene/:turnIndex/status",
  wrap(async (req, res) =>
    imageStatusResponse(
      res,
      paths.sceneImage(req.params.storyId, req.params.turnIndex),
      `scene:${req.params.storyId}:${req.params.turnIndex}`
    )
  )
);

// Look up a turn by index from recentTurns (fast) or the full transcript.
function findTurn(storyId, index) {
  try {
    const story = readJSON(paths.storyFile(storyId));
    const recent = (story.recentTurns || []).find((t) => t.index === index);
    if (recent) return recent;
  } catch {
    /* fall through */
  }
  try {
    const log = readJSON(paths.transcriptFile(storyId), { turns: [] });
    return log.turns.find((t) => t.index === index) || null;
  } catch {
    return null;
  }
}

app.post(
  "/api/story/:storyId/export",
  wrap(async (req, res) => {
    const { storyId } = req.params;
    if (!exists(paths.storyFile(storyId)))
      return res.status(404).json({ error: "story not found" });
    const outPath = await exportEbook(storyId);
    res.json({
      ok: true,
      file: path.basename(outPath),
      url: `/api/story/${storyId}/export/${path.basename(outPath)}`,
    });
  })
);

app.get(
  "/api/story/:storyId/export/:file",
  wrap(async (req, res) => {
    const { storyId, file } = req.params;
    const full = path.join(paths.exportsDir(storyId), path.basename(file));
    if (!exists(full)) return res.status(404).json({ error: "export not found" });
    res.download(full);
  })
);

// ---- helpers ---------------------------------------------------------------
function buildStorySoFar(storyId, story) {
  const chapters = listChapters(storyId);
  const recaps = chapters.map((c) => `Chapter ${c.index} — ${c.title}: ${c.recap}`);
  const parts = [...recaps];
  if (story.scene?.summary)
    parts.push(`Now: ${story.scene.summary} (at ${story.scene.location}).`);
  return parts.join("\n\n");
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`\n  Unwritten running → http://localhost:${PORT}`);
  const llm = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
  const keyName = llm === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  const model =
    llm === "gemini"
      ? process.env.GEMINI_MODEL || "gemini-2.5-flash"
      : process.env.MODEL || "claude-sonnet-4-6";
  const images = (process.env.IMAGE_PROVIDER || "none").toLowerCase();
  console.log(`  text: ${llm} (${model}) · images: ${images}`);
  if (!process.env[keyName]) {
    console.log(`  ⚠  ${keyName} not set — add it to .env (or set LLM_PROVIDER=anthropic to use Claude).`);
  }
  if (images === "gemini" && !process.env.GEMINI_API_KEY) {
    console.log("  ⚠  IMAGE_PROVIDER=gemini needs GEMINI_API_KEY (or use IMAGE_PROVIDER=pollinations).");
  }
  console.log("");
});
