// storage.js — local filesystem persistence: paths + JSON read/write helpers.
// Layout (see Technical Spec §4):
//   data/worlds/<worldId>/{world.json, boundaries.json}
//   data/stories/<storyId>/{story.json, stories/, memories/, characters/, exports/}
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Anchor the data directory to the PROJECT ROOT, not the process working
// directory. Otherwise launching `node server.js` from a different folder would
// read/write a different `data/` and look like a lost save. A relative DATA_DIR
// in .env is resolved against the project root; an absolute DATA_DIR is used as-is.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const _envDir = process.env.DATA_DIR;
const DATA_DIR = _envDir
  ? path.isAbsolute(_envDir)
    ? _envDir
    : path.resolve(PROJECT_ROOT, _envDir)
  : path.join(PROJECT_ROOT, "data");

// ---- path helpers ----------------------------------------------------------
export const paths = {
  data: () => DATA_DIR,

  worlds: () => path.join(DATA_DIR, "worlds"),
  world: (worldId) => path.join(DATA_DIR, "worlds", worldId),
  worldFile: (worldId) => path.join(DATA_DIR, "worlds", worldId, "world.json"),
  boundariesFile: (worldId) =>
    path.join(DATA_DIR, "worlds", worldId, "boundaries.json"),

  stories: () => path.join(DATA_DIR, "stories"),
  story: (storyId) => path.join(DATA_DIR, "stories", storyId),
  storyFile: (storyId) => path.join(DATA_DIR, "stories", storyId, "story.json"),

  // narrative subfolder (the story's prose + chapters)
  narrativeDir: (storyId) => path.join(DATA_DIR, "stories", storyId, "stories"),
  transcriptFile: (storyId) =>
    path.join(DATA_DIR, "stories", storyId, "stories", "transcript.json"),
  chaptersDir: (storyId) =>
    path.join(DATA_DIR, "stories", storyId, "stories", "chapters"),
  chapterFile: (storyId, n) =>
    path.join(DATA_DIR, "stories", storyId, "stories", "chapters", `${n}.json`),
  chapterImage: (storyId, n) =>
    path.join(DATA_DIR, "stories", storyId, "stories", "chapters", `${n}.png`),
  // path relative to data dir, stored in chapter records
  chapterImageRel: (storyId, n) =>
    path.posix.join("stories", storyId, "stories", "chapters", `${n}.png`),

  memoriesDir: (storyId) => path.join(DATA_DIR, "stories", storyId, "memories"),
  memoryFile: (storyId) =>
    path.join(DATA_DIR, "stories", storyId, "memories", "memory.json"),

  charactersDir: (storyId) =>
    path.join(DATA_DIR, "stories", storyId, "characters"),
  playerFile: (storyId) =>
    path.join(DATA_DIR, "stories", storyId, "characters", "player.json"),
  npcFile: (storyId, npcId) =>
    path.join(DATA_DIR, "stories", storyId, "characters", `${npcId}.json`),
  // v0.2 §7 — per-character portrait (next to <id>.json)
  portrait: (storyId, charId) =>
    path.join(DATA_DIR, "stories", storyId, "characters", `${charId}.png`),
  portraitRel: (storyId, charId) =>
    path.posix.join("stories", storyId, "characters", `${charId}.png`),

  // v0.2 §9 — in-chapter scene/action images
  scenesDir: (storyId) => path.join(DATA_DIR, "stories", storyId, "scenes"),
  sceneImage: (storyId, turnIndex) =>
    path.join(DATA_DIR, "stories", storyId, "scenes", `${turnIndex}.png`),
  sceneImageRel: (storyId, turnIndex) =>
    path.posix.join("stories", storyId, "scenes", `${turnIndex}.png`),

  // v0.2 §4 — world-state ledger
  stateDir: (storyId) => path.join(DATA_DIR, "stories", storyId, "state"),
  ledgerFile: (storyId) =>
    path.join(DATA_DIR, "stories", storyId, "state", "ledger.json"),

  exportsDir: (storyId) => path.join(DATA_DIR, "stories", storyId, "exports"),
};

// ---- fs helpers ------------------------------------------------------------
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p) {
  return fs.existsSync(p);
}

export function readJSON(file, fallback = undefined) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`File not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// Create the full subfolder skeleton for a new story.
export function scaffoldStory(storyId) {
  ensureDir(paths.story(storyId));
  ensureDir(paths.chaptersDir(storyId));
  ensureDir(paths.memoriesDir(storyId));
  ensureDir(paths.charactersDir(storyId));
  ensureDir(paths.scenesDir(storyId));
  ensureDir(paths.stateDir(storyId));
  ensureDir(paths.exportsDir(storyId));
}

// Append a turn to the full on-disk transcript log.
export function appendTranscript(storyId, turn) {
  const file = paths.transcriptFile(storyId);
  const log = readJSON(file, { turns: [] });
  log.turns.push(turn);
  writeJSON(file, log);
}

export function readTranscript(storyId) {
  return readJSON(paths.transcriptFile(storyId), { turns: [] });
}
