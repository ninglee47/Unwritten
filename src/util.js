// util.js — small shared helpers.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

// Cache prompts, but invalidate when the file changes on disk — otherwise edits to
// prompts/*.md never take effect in a running server (they aren't in Node's import
// graph, so a plain restart or --watch won't reliably pick them up either). statSync
// per call is cheap.
const _cache = new Map();
export function loadPrompt(name) {
  const file = path.join(PROMPTS_DIR, name);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    /* fall through to read, which will throw a clear error if missing */
  }
  const cached = _cache.get(name);
  if (cached && cached.mtime === mtime) return cached.text;
  const text = fs.readFileSync(file, "utf8");
  _cache.set(name, { text, mtime });
  return text;
}

export function nowISO() {
  return new Date().toISOString();
}

// Normalize a character name for the dedupe registry (v0.2 §3.4):
// lowercase, trim, collapse internal whitespace.
export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// F10: the GM sometimes emits a placeholder/id token where a character NAME belongs
// (e.g. "orrath_id", "<npcId>", "npc_orrath") when it means to REFERENCE an existing
// character. Strip that decoration to the bare name; return "" if nothing real remains
// (a pure placeholder the engine should ignore rather than turn into a new NPC).
export function cleanCharacterName(name) {
  let s = String(name || "").trim();
  if (!s) return "";
  s = s.replace(/[<>{}[\]]/g, " "); // <npcId>, {name}
  s = s.replace(/^npc[ _-]+/i, ""); // leading technical prefix
  s = s.replace(/[ _-]+id$/i, ""); // trailing _id / -id reference suffix
  s = s.replace(/\s+/g, " ").trim();
  // bare technical tokens or a hex slug are not real names
  if (!s || /^(npc|id|name|character|npcid)$/i.test(s) || /^[0-9a-f]{6,}$/i.test(s)) return "";
  return s;
}

// ---- F6: guarded fuzzy name matching --------------------------------------
// Leading honorifics that are titles, not part of the core name.
const HONORIFICS = new Set([
  "captain", "ser", "sir", "lady", "lord", "elder", "master", "mistress",
  "dr", "doctor", "dame", "madam", "mister", "mr", "mrs", "ms", "the", "old",
]);

// Strip titles/epithets/appositives to a comparable core name:
//   "Orrath the Unsutured" → "orrath"; "Captain Roel" → "roel";
//   "Orrath, Elder shaman of the wood" → "orrath".
export function coreName(s) {
  let x = normalizeName(s).split(",")[0].trim(); // drop trailing comma-appositive
  x = x.replace(/\s+the\s+.+$/i, "").trim(); // drop trailing "the <epithet>"
  const parts = x.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && HONORIFICS.has(parts[0])) parts.shift();
  return parts.join(" ").trim();
}

// Significant name tokens (honorifics / "the" removed).
export function nameTokens(s) {
  return normalizeName(s)
    .split(/\s+/)
    .filter((t) => t && t !== "the" && !HONORIFICS.has(t));
}

// True when two names differ by a possessive / kinship / ordinal marker — i.e.
// they are legitimately DIFFERENT people (Ceth vs Ceth's Daughter) and must
// never be merged, even if their tokens overlap.
const RELATIONAL =
  /('s\b|\bof\b|\bson\b|\bdaughter\b|\bchild\b|\bwife\b|\bhusband\b|\bbrother\b|\bsister\b|\bfather\b|\bmother\b|\bthe (younger|elder|second|third|great)\b|\b(ii|iii|iv|jr|sr)\b)/i;
export function isRelationalVariant(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return false;
  // a relational marker present in exactly one of the two names → distinct people
  return RELATIONAL.test(na) !== RELATIONAL.test(nb);
}

// Common sentence-initial / capitalized words that are NOT entities. Without
// this filter, "The", "You", "When" etc. pollute the retrieval focus set and
// spuriously reinforce/decay memories (§3.5).
const STOPWORDS = new Set(
  [
    "The", "A", "An", "You", "Your", "Yours", "He", "She", "It", "They", "We",
    "I", "His", "Her", "Their", "This", "That", "These", "Those", "Here",
    "There", "When", "Where", "What", "Who", "Why", "How", "Then", "Now",
    "And", "But", "Or", "If", "So", "As", "At", "On", "In", "Of", "To", "For",
    "With", "From", "By", "Into", "Onto", "Yes", "No", "Not", "Do", "Does",
    "Did", "Is", "Are", "Was", "Were", "Be", "Been", "Will", "Would", "Could",
    "Should", "Can", "May", "Might", "Must", "Let", "Its", "One", "Two",
    "Three", "After", "Before", "Behind", "Beyond", "Above", "Below", "Once",
    "Still", "Just", "Even", "Only", "Suddenly", "Perhaps", "Maybe", "Inside",
    "Outside", "Across", "Around", "Without", "Within", "Toward", "Through",
  ].map((w) => w)
);

// Cheap entity extraction: known names (highest confidence) + capitalized,
// non-stopword tokens. Multi-word proper nouns and known names are favored.
export function extractEntities(text, knownNames = []) {
  const ents = new Set();
  for (const name of knownNames) {
    if (name && text && text.toLowerCase().includes(name.toLowerCase())) {
      ents.add(name);
    }
  }
  const caps = (text || "").match(/\b[A-Z][a-zA-Z']{2,}\b/g) || [];
  for (const c of caps) {
    if (!STOPWORDS.has(c)) ents.add(c);
  }
  return [...ents];
}
