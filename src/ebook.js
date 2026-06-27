// ebook.js — compile a story into an ebook PDF (Technical Spec §9A).
// Pure-Node via PDFKit: title page, TOC, per-chapter prose + illustration,
// optional character appendix.
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { paths, readJSON, exists } from "./storage.js";
import { loadWorld } from "./worldGen.js";
import { listChapters } from "./chapters.js";
import { nowISO } from "./util.js";

const PAGE = { margin: 64 };
const COLORS = { ink: "#1a1a1a", muted: "#666", accent: "#7c3f2e" };

export async function exportEbook(storyId) {
  const story = readJSON(paths.storyFile(storyId));
  const world = loadWorld(story.worldId);
  const player = readJSON(paths.playerFile(storyId));
  const chapters = listChapters(storyId);

  const stamp = nowISO().replace(/[:.]/g, "-");
  const outPath = path.join(paths.exportsDir(storyId), `${storyId}-${stamp}.pdf`);
  fs.mkdirSync(paths.exportsDir(storyId), { recursive: true });

  const doc = new PDFDocument({
    size: "A5",
    margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
    bufferPages: true,
    info: { Title: story.title, Author: player.name },
  });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // ---- 1. Title page ----
  titlePage(doc, { story, world, player });

  // ---- 2. TOC placeholder page (filled after we know page numbers) ----
  doc.addPage();
  const tocPageIndex = pageIndex(doc);

  // ---- 3. Chapters ----
  const tocEntries = [];
  for (const ch of chapters) {
    doc.addPage();
    tocEntries.push({ title: `${ch.index}. ${ch.title}`, page: printedPageNumber(doc) });
    chapterPage(doc, ch, storyId);
  }

  // In-progress: add a "to be continued" stub for the current open chapter.
  const lastClosed = chapters.length ? chapters[chapters.length - 1].index : 0;
  if (story.chapter.index > lastClosed) {
    doc.addPage();
    tocEntries.push({
      title: `${story.chapter.index}. (in progress)`,
      page: printedPageNumber(doc),
    });
    inProgressPage(doc, story);
  }

  // ---- 4. Appendix: character profiles ----
  doc.addPage();
  const appendixPage = printedPageNumber(doc);
  appendixPages(doc, storyId, player);
  tocEntries.push({ title: "Appendix — Dramatis Personae", page: appendixPage });

  // ---- Fill the TOC ----
  doc.switchToPage(tocPageIndex);
  renderTOC(doc, tocEntries);

  doc.flushPages();
  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return outPath;
}

// ---- page builders ---------------------------------------------------------
function titlePage(doc, { story, world, player }) {
  doc.moveDown(4);
  doc
    .fillColor(COLORS.ink)
    .font("Helvetica-Bold")
    .fontSize(30)
    .text(story.title, { align: "center" });
  doc.moveDown(1);
  doc
    .font("Helvetica-Oblique")
    .fontSize(14)
    .fillColor(COLORS.muted)
    .text(`A tale of ${world.title}`, { align: "center" });
  doc.moveDown(0.4);
  doc.fontSize(11).text(`${world.genre} · ${world.tone}`, { align: "center" });
  doc.moveDown(6);
  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor(COLORS.ink)
    .text(`as played by ${player.name}`, { align: "center" });
  doc
    .fontSize(10)
    .fillColor(COLORS.muted)
    .text(new Date().toLocaleDateString(), { align: "center" });
}

function renderTOC(doc, entries) {
  doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.accent).text("Contents");
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(12).fillColor(COLORS.ink);
  for (const e of entries) {
    const y = doc.y;
    doc.text(e.title, PAGE.margin, y, { continued: false });
    doc.text(String(e.page), PAGE.margin, y, {
      align: "right",
      width: doc.page.width - PAGE.margin * 2,
    });
    doc.moveDown(0.5);
  }
}

function chapterPage(doc, ch, storyId) {
  doc.font("Helvetica-Bold").fontSize(22).fillColor(COLORS.accent).text(`Chapter ${ch.index}`);
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold").fontSize(16).fillColor(COLORS.ink).text(ch.title);
  doc.moveDown(0.8);

  // illustration at the chapter break (if rendered)
  const imgFile = paths.chapterImage(storyId, ch.index);
  if (ch.imagePath && exists(imgFile)) {
    try {
      const w = doc.page.width - PAGE.margin * 2;
      doc.image(imgFile, { width: w });
      doc.moveDown(0.8);
    } catch {
      /* skip bad image */
    }
  } else if (ch.imagePrompt) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(`[illustration: ${ch.imagePrompt}]`, { align: "center" });
    doc.moveDown(0.8);
  }

  // narrative prose
  doc.font("Helvetica").fontSize(11.5).fillColor(COLORS.ink);
  for (const turn of ch.narrativeTurns || []) {
    if (turn.playerInput) {
      doc
        .font("Helvetica-Oblique")
        .fillColor(COLORS.muted)
        .text(`» ${turn.playerInput}`);
      doc.font("Helvetica").fillColor(COLORS.ink);
    }
    if (turn.narration) {
      doc.moveDown(0.3);
      for (const para of turn.narration.split(/\n\n+/)) {
        doc.text(para.trim(), { align: "left", lineGap: 2 });
        doc.moveDown(0.4);
      }
    }
    // inline scene/action image for this turn, if one was rendered (v0.2 §9)
    if (turn.sceneImage) {
      const sceneFile = paths.sceneImage(storyId, turn.index);
      if (exists(sceneFile)) {
        try {
          doc.moveDown(0.2);
          doc.image(sceneFile, { width: doc.page.width - PAGE.margin * 2 });
          doc.moveDown(0.5);
        } catch {
          /* skip bad image */
        }
      }
    }
  }

  if (ch.turningPoint) {
    doc.moveDown(0.6);
    doc
      .font("Helvetica-Oblique")
      .fontSize(10.5)
      .fillColor(COLORS.accent)
      .text(`Turning point: ${ch.turningPoint}`);
  }
}

function inProgressPage(doc, story) {
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(COLORS.accent)
    .text(`Chapter ${story.chapter.index}`);
  doc.moveDown(0.8);
  doc.font("Helvetica").fontSize(11.5).fillColor(COLORS.ink);
  for (const turn of story.recentTurns || []) {
    if (turn.index === 0 && story.chapter.index !== 1) continue;
    if (turn.chapter !== story.chapter.index) continue;
    if (turn.playerInput) {
      doc.font("Helvetica-Oblique").fillColor(COLORS.muted).text(`» ${turn.playerInput}`);
      doc.font("Helvetica").fillColor(COLORS.ink);
    }
    if (turn.narration) {
      doc.moveDown(0.3);
      doc.text(turn.narration, { lineGap: 2 });
      doc.moveDown(0.4);
    }
  }
  doc.moveDown(1);
  doc.font("Helvetica-Oblique").fillColor(COLORS.muted).text("…to be continued.", { align: "center" });
}

function appendixPages(doc, storyId, player) {
  doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.accent).text("Dramatis Personae");
  doc.moveDown(1);

  profile(doc, player, true);

  const charDir = paths.charactersDir(storyId);
  const files = fs.existsSync(charDir)
    ? fs.readdirSync(charDir).filter((f) => f.endsWith(".json") && f !== "player.json")
    : [];
  for (const f of files) {
    const npc = readJSON(path.join(charDir, f));
    profile(doc, npc, false);
  }
}

function profile(doc, c, isPlayer) {
  doc.moveDown(0.6);
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(COLORS.ink)
    .text(`${c.name}${isPlayer ? " (you)" : ""} — ${c.role || ""}`);
  const stats = Object.entries(c.stats || {})
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  if (stats) doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted).text(stats);
  if (c.mentalStatus?.state) {
    doc.fontSize(10).fillColor(COLORS.muted).text(`Last seen: ${c.mentalStatus.state}`);
  }
  if (!isPlayer && typeof c.relationshipToPlayer === "number") {
    doc.fontSize(10).fillColor(COLORS.muted).text(`Disposition toward you: ${c.relationshipToPlayer}`);
  }
}

// ---- page-number helpers ---------------------------------------------------
function pageIndex(doc) {
  const range = doc.bufferedPageRange();
  return range.start + range.count - 1;
}
function printedPageNumber(doc) {
  return pageIndex(doc) + 1; // 1-based for humans
}
