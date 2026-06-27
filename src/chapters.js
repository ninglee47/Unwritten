// chapters.js — chapter segmentation, recap, image prompt (Technical Spec §9).
import { callGMStructured } from "./llm.js";
import { RecapSchema } from "./schemas.js";
import {
  paths,
  writeJSON,
  readJSON,
  readTranscript,
  exists,
} from "./storage.js";
import { loadPrompt } from "./util.js";
import { composeImagePrompt } from "./imagePrompt.js";
import { loadLedger, durableSnapshot } from "./ledger.js";

// The hard ceiling of beats a chapter may run before it is force-closed (F3).
export function chapterHardCap(targetBeats) {
  const factor = Number(process.env.CHAPTER_HARD_CAP_FACTOR || 1.5);
  const extra = process.env.CHAPTER_HARD_CAP_EXTRA;
  const cap = extra != null ? targetBeats + Number(extra) : Math.ceil(targetBeats * factor);
  return Math.max(cap, targetBeats + 1);
}

// Should the current chapter close? Either the GM signalled a turning point at
// or past the target floor, OR the hard cap is hit (a chapter can never run
// past the ceiling, even if the GM never finds a "genuine" turning point — F3).
// Returns { close, forced }: forced=true means the cap, not the GM, triggered it.
export function shouldCloseChapter(story, chapterShouldEnd) {
  const { beatCount, targetBeats } = story.chapter;
  const cap = chapterHardCap(targetBeats);
  if (beatCount >= cap) return { close: true, forced: true };
  if (chapterShouldEnd && beatCount >= targetBeats) return { close: true, forced: false };
  return { close: false, forced: false };
}

// Close the current chapter: generate recap + image prompt, render image (or
// placeholder), write the chapter record, and advance the story to the next.
// `characters` (Map) is used to compose a portrait-anchored image prompt (§8).
// `forced` (F3): the hard cap closed the chapter, so tell the recap to land a
// turning point / cliffhanger from the current state.
export async function closeChapter(world, story, player, characters = new Map(), { forced = false } = {}) {
  const index = story.chapter.index;

  // Gather this chapter's turns from the full transcript.
  const transcript = readTranscript(story.storyId);
  const chapterTurns = transcript.turns.filter((t) => t.chapter === index);
  const startTurn = chapterTurns.length ? chapterTurns[0].index : 0;
  const endTurn = chapterTurns.length
    ? chapterTurns[chapterTurns.length - 1].index
    : 0;

  // Build a compact prose blob for the recap call.
  const prose = chapterTurns
    .map((t) =>
      [t.playerInput ? `> ${t.playerInput}` : "", t.narration]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  const sys = loadPrompt("chapter_recap.md");
  const forcedNote = forced
    ? `\nWRAP-FROM-HERE MODE: this chapter has run long and must end now. Land a satisfying turning point or cliffhanger drawn from where the story currently stands — do not introduce new threads. Make the close read like a real chapter ending.\n`
    : "";
  const userMsg = `WORLD: ${world.title} (${world.genre}), tone: ${world.tone}
PLAYER VISUAL DESCRIPTOR (use in image prompt for consistency): ${player.visualDescriptor || "(none)"}
ART STYLE HINT: illustration matching a ${world.genre} setting.
${forcedNote}
CHAPTER ${index} NARRATIVE:
${prose}

Close this chapter.`;

  let recap;
  try {
    recap = await callGMStructured(
      sys,
      [{ role: "user", content: userMsg }],
      RecapSchema,
      1200
    );
  } catch {
    recap = {
      title: `Chapter ${index}`,
      recap: chapterTurns[chapterTurns.length - 1]?.narration?.slice(0, 400) || "",
      turningPoint: "",
      imagePrompt: `A defining moment from chapter ${index} of ${world.title}.`,
    };
  }

  // Compose a portrait-anchored prompt from the characters featured at the
  // turning point (player + whoever is present), for cross-chapter consistency.
  const featured = [player, ...story.scene.present.map((id) => characters.get(id))].filter(Boolean);
  const referenceCharacterIds = featured.map((c) => c.id);
  const { prompt: composedPrompt } = composeImagePrompt({
    world,
    characters: featured,
    moment: recap.imagePrompt,
  });

  // Snapshot the open durable ledger facts so "story so far" + ebook stay
  // consistent across chapters (v0.2 §4.3).
  const durableFacts = durableSnapshot(loadLedger(story.storyId));

  // The image renders lazily, off the turn's critical path: the chapter is saved
  // with imagePath=null, and `GET /api/story/:id/image/:n` renders it on first
  // request (and records imagePath then), keeping the chapter-closing turn fast.
  const chapterRecord = {
    storyId: story.storyId,
    index,
    title: recap.title,
    recap: recap.recap,
    turningPoint: recap.turningPoint || "",
    narrativeTurns: chapterTurns,
    imagePrompt: composedPrompt,
    imagePath: null,
    referenceCharacterIds,
    durableFacts,
    startTurn,
    endTurn,
  };
  writeJSON(paths.chapterFile(story.storyId, index), chapterRecord);

  // Advance the story to the next chapter (reset per-chapter scene-image budget).
  story.chapter = {
    index: index + 1,
    beatCount: 0,
    targetBeats: story.chapter.targetBeats,
    sceneImages: 0,
  };

  return chapterRecord;
}

// List chapter records (for the gallery).
export function listChapters(storyId) {
  const out = [];
  let n = 1;
  while (exists(paths.chapterFile(storyId, n))) {
    out.push(readJSON(paths.chapterFile(storyId, n)));
    n++;
  }
  return out;
}
