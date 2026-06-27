// contextBuilder.js — assembles the prompt context for a turn (Technical Spec §6 step 2).
import { loadPrompt, normalizeName } from "./util.js";
import { summarize as summarizeMental } from "./mentalStatus.js";
import { activeGoals } from "./goals.js";
import { chapterHardCap } from "./chapters.js";

// Escalating end-of-chapter guidance (F3): gentle past the floor, urgent near
// the hard cap so the GM lands a turning point before the engine forces one.
function chapterNudge(chapter) {
  const { beatCount, targetBeats } = chapter;
  const cap = chapterHardCap(targetBeats);
  if (beatCount >= cap - 2) {
    return `This chapter MUST end by beat ${cap} (you are at ${beatCount}). Steer THIS turn decisively to a turning point or cliffhanger and set chapterShouldEnd=true now — do NOT open new threads.`;
  }
  if (beatCount >= targetBeats) {
    return "You are AT or PAST the target beat count — bring the chapter toward a turning point; if this turn reaches a natural turning point or cliffhanger, set chapterShouldEnd=true.";
  }
  return "Keep building tension toward a turning point.";
}

// Build the system prompt (GM rules + world bible + boundaries).
export function buildSystemPrompt(world) {
  const base = loadPrompt("system_gm.md");
  return `${base}

# WORLD BIBLE — "${world.title}" (${world.genre})
Premise: ${world.premise}
Tone: ${world.tone}
Stat schema: ${world.statSchema.join(", ")}
Content boundaries: ${JSON.stringify(world.contentBoundaries)}

${world.worldBible}${backgroundBlock(world.background)}`;
}

// Compact, enumerated structured background so factions/places/rules are
// explicit for the GM (v0.2 §6.3). Absent on pre-v0.2 worlds.
function backgroundBlock(bg) {
  if (!bg) return "";
  const lines = [];
  if (bg.overview) lines.push(bg.overview);
  if (bg.factions?.length)
    lines.push(`Factions: ${bg.factions.map((f) => `${f.name} — ${f.summary}`).join(" | ")}`);
  if (bg.places?.length)
    lines.push(`Places: ${bg.places.map((p) => `${p.name} — ${p.summary}`).join(" | ")}`);
  if (bg.history) lines.push(`History: ${bg.history}`);
  if (bg.rules) lines.push(`Rules of this world: ${bg.rules}`);
  return lines.length ? `\n\n# WORLD BACKGROUND (honor these facts)\n${lines.join("\n")}` : "";
}

// Build a single user message carrying the dynamic per-turn context, plus the
// recent-turn dialogue history as alternating messages.
export function buildMessages({
  world,
  story,
  player,
  npcs, // array of npc characters present/known
  memories, // retrieved memory items
  ledgerFacts = [], // active world-state ledger facts (v0.2 §4)
  diceResult,
  playerInput,
}) {
  const presentNpcs = npcs.filter((n) => story.scene.present.includes(n.id));

  // id → display name, for resolving memory witnesses to readable names.
  const idToName = { [player.id]: player.name, player: player.name };
  for (const n of npcs) idToName[n.id] = n.name;
  const nameOf = (id) => idToName[id] || id;

  const sceneBlock = `# CURRENT SCENE
Location: ${story.scene.location} · Time: ${story.scene.timeOfDay}
Situation: ${story.scene.summary || "(unfolding)"}
Present (NPC ids): ${story.scene.present.join(", ") || "(no NPCs)"}`;

  // F11: acquaintance — who in the scene knows whom BY NAME. Gates forms of address.
  const presentCast = [player, ...presentNpcs];
  const knowsPlayer = presentNpcs.filter((n) => (n.knownCharacters || []).includes(player.id));
  const strangersToPlayer = presentNpcs.filter(
    (n) => !(n.knownCharacters || []).includes(player.id)
  );
  const addressLine = `Forms of address: ${
    knowsPlayer.length
      ? `${knowsPlayer.map((n) => n.name).join(", ")} know your name (${player.name}).`
      : `No one present knows your name yet.`
  }${
    strangersToPlayer.length
      ? ` ${strangersToPlayer.map((n) => n.name).join(", ")} do NOT — they address you generically (by bearing/role, e.g. "the spearman"), never by name, until you tell them. `
      : " "
  }Do NOT turn your role/class ("${player.role}") into an honorific.`;

  const playerProfile = profileLines(player.profile, "  ");
  const playerBlock = `# PLAYER CHARACTER (id: ${player.id})
${player.name} — ${player.role}
Stats: ${fmtStats(player.stats)}
Mental status: ${summarizeMental(player)}${player.persona ? `\nPersona: ${player.persona}` : ""}${
    playerProfile ? `\n${playerProfile}` : ""
  }${
    player.canon?.length ? `\nEstablished facts (never contradict):\n${player.canon.map((c) => `  • ${c}`).join("\n")}` : ""
  }
${addressLine}`;

  const npcBlock = presentNpcs.length
    ? `# NPCs IN SCENE — voice each from their profile + ONLY their own memories; a character names another ONLY if listed under "knows by name"
${presentNpcs.map((n) => npcLines(n, memories, presentCast)).join("\n")}`
    : "# NPCs IN SCENE\n(none)";

  const goalsBlock = `# ACTIVE GOALS / THREADS
${activeGoals(story.goals).map((g) => `- (${g.id}) ${g.text}`).join("\n") || "(none yet)"}`;

  const invBlock = `# INVENTORY (authoritative — the player carries EXACTLY these items, nothing more)
${(story.inventory || []).map(itemLine).join("\n") || "(empty)"}`;

  // WORLD STATE ledger — authoritative, never-contradict facts (v0.2 §4).
  const wsBlock = ledgerFacts.length
    ? `# WORLD STATE (authoritative — never contradict)
${ledgerFacts.map((f) => `- [${f.kind}${f.durable ? "*" : ""}] ${f.text}`).join("\n")}`
    : "";

  // Encounter / activity context (v0.2 §10, §10A).
  const encBlock = story.encounter?.active
    ? `# ENCOUNTER IN PROGRESS — ${story.encounter.kind} (round ${story.encounter.round})
Stakes: ${story.encounter.stakes || "(unspecified)"}
Player condition: ${story.encounter.playerCondition}
${story.encounter.participants.map((p) => `- ${nameOf(p.id)}: ${p.condition}`).join("\n") || "(no other combatants)"}
Resolve this round through checks; advance conditions via deltas.encounter.round. Keep asking the player each round. End with deltas.encounter.end when it resolves.`
    : "";
  const actBlock = story.activity?.active
    ? `# ACTIVITY IN PROGRESS — ${story.activity.kind} (beat ${story.activity.beat})
${story.activity.summary || ""}
This is a cooperative/social beat: resolve with social outcomes (mental-status, relationship, witnessed memories), not damage. End with deltas.activity.end when it winds down.`
    : "";

  const memBlock = `# RELEVANT LONG-TERM MEMORY — YOUR (the GM's) OMNISCIENT KNOWLEDGE
NPCs do NOT share this knowledge. "known by" lists who actually witnessed each fact; an NPC may only act on facts they are listed in (or could plausibly infer). When in doubt, the NPC does not know.
${
    memories
      .map((m) => {
        const known = (m.witnesses || []).length
          ? m.witnesses.map(nameOf).join(", ")
          : "unknown";
        return `- (${m.id}) [w${m.weight} ${m.type} | known by: ${known}] ${m.text}`;
      })
      .join("\n") || "(none yet)"
  }`;

  const diceBlock = diceResult
    ? `# DICE RESULT (dramatize this exact outcome — do not override it)
Check: ${diceResult.stat} vs DC ${diceResult.dc}
Roll: d20=${diceResult.d20} + statMod ${signed(diceResult.statMod)} + mentalMod ${signed(diceResult.mentalMod)}${diceResult.situationalModifier ? ` + situational ${signed(diceResult.situationalModifier)}` : ""} = ${diceResult.total}
Outcome: ${diceResult.outcome.toUpperCase()}`
    : "";

  const chapterBlock = `# CHAPTER
Chapter ${story.chapter.index}, beat ${story.chapter.beatCount}/${story.chapter.targetBeats}. ${chapterNudge(story.chapter)}`;

  // F7 + F9: dynamic anti-repetition guard — show the GM its own recent openings AND
  // last turn's suggested actions, so it neither re-opens the same way nor re-offers
  // the same moves round after round.
  const priorOpenings = story.recentTurns
    .filter((t) => t.narration)
    .slice(-2)
    .map((t) => firstSentence(t.narration));
  const lastActions =
    [...story.recentTurns].reverse().find((t) => (t.suggestedActions || []).length)
      ?.suggestedActions || [];
  const repeatParts = [];
  if (priorOpenings.length)
    repeatParts.push(`Your recent turns already opened with:
${priorOpenings.map((s) => `- "${s}"`).join("\n")}
Do NOT open this turn with the same or a similar sentence, and do NOT re-describe the established setting (you are already at ${story.scene.location}). Begin from a NEW concrete detail, action, or line of dialogue and ADVANCE the scene.`);
  if (lastActions.length)
    repeatParts.push(`Last turn you offered these suggested actions:
${lastActions.map((a) => `- "${a}"`).join("\n")}
This turn, offer DIFFERENT \`suggestedActions\` — do NOT repeat or lightly reword any of the above. Give fresh, concrete options that fit the new situation and move the story forward.`);
  const antiRepeatBlock = repeatParts.length
    ? `# AVOID REPETITION (critical)\n${repeatParts.join("\n\n")}`
    : "";

  const contextMessage = [
    sceneBlock,
    encBlock,
    actBlock,
    playerBlock,
    npcBlock,
    goalsBlock,
    invBlock,
    wsBlock,
    memBlock,
    chapterBlock,
    diceBlock,
    antiRepeatBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Recent turns as dialogue history for local coherence.
  const history = [];
  for (const t of story.recentTurns) {
    if (t.playerInput) history.push({ role: "user", content: t.playerInput });
    if (t.narration) history.push({ role: "assistant", content: t.narration });
  }
  // The Anthropic API requires the first message to be `user`. The opening turn
  // has no player input, so history can begin with the GM's opening narration —
  // prepend a stub user message in that case.
  if (history.length && history[0].role === "assistant") {
    history.unshift({ role: "user", content: "Begin the story." });
  }

  const finalUser = `${contextMessage}

# PLAYER INPUT
${playerInput}

Resolve this turn. Respond with ONLY the json block.`;

  return [...history, { role: "user", content: finalUser }];
}

// Render a present NPC with the anchors needed for consistent voicing:
// profile (faction/occupation/personality/powers/weapons), mental status,
// established canon, AND the memories this NPC personally witnessed (v0.3 §5.4).
function npcLines(n, memories, presentCast = []) {
  const head = `- ${n.displayName || n.name} (id: ${n.id}) — ${n.role}; relationship ${n.relationshipToPlayer ?? 0}; mental: ${summarizeMental(n)}`;
  const prof = profileLines(n.profile);
  const persona = n.persona && !prof ? `\n    persona: ${n.persona}` : "";
  const canon = n.canon?.length
    ? `\n    established facts (never contradict): ${n.canon.join("; ")}`
    : "";
  const known = scopedMemoriesFor(n, memories);
  const knows = known.length
    ? `\n    knows (own memories only): ${known.map((m) => `[w${m.weight}] ${m.text}`).join(" | ")}`
    : "";
  // F11: who else in the scene this NPC knows by name vs. is a stranger to.
  const others = presentCast.filter((c) => c.id !== n.id);
  const kc = n.knownCharacters || [];
  const knowByName = others.filter((c) => kc.includes(c.id)).map((c) => c.displayName || c.name);
  const strangers = others.filter((c) => !kc.includes(c.id)).map((c) => c.displayName || c.name);
  const acquaint = others.length
    ? `\n    knows by name: ${knowByName.length ? knowByName.join(", ") : "(no one here)"}${
        strangers.length ? ` | STRANGER to (address generically, do NOT name until introduced): ${strangers.join(", ")}` : ""
      }`
    : "";
  const carries = carriesLine(n.inventory);
  return head + (prof ? `\n${prof}` : "") + persona + canon + knows + acquaint + carries;
}

// One carried item, with category + flags, for context.
function itemLine(i) {
  if (!i) return "";
  const flags = [
    i.kind && i.kind !== "misc" ? i.kind : "",
    i.equipped ? "equipped" : "",
    i.signature ? "signature" : "",
    i.concealed ? "concealed" : "",
    i.significance ? `matters: ${i.significance}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${i.name}${i.desc ? `: ${i.desc}` : ""}${flags ? ` [${flags}]` : ""}`;
}

// A character's carried items for context: known items listed plainly; concealed
// items shown to the GM but tagged "do not reveal" so a hidden knife never leaks.
function carriesLine(inv) {
  if (!inv || !inv.length) return "";
  const open = inv.filter((i) => !i.concealed);
  const hidden = inv.filter((i) => i.concealed);
  let out = "";
  if (open.length)
    out += `\n    carries (visible): ${open.map((i) => i.name + (i.kind === "weapon" ? " (weapon)" : "")).join(", ")}`;
  if (hidden.length)
    out += `\n    carries (CONCEALED — do not reveal to the player until shown): ${hidden.map((i) => i.name).join(", ")}`;
  return out;
}

// Memories this character witnessed (matched by id or normalized name).
function scopedMemoriesFor(c, memories) {
  const names = [c.id, c.name, c.displayName].filter(Boolean).map((x) => normalizeName(x));
  return (memories || []).filter((m) =>
    (m.witnesses || []).some((w) => names.includes(normalizeName(w)) || w === c.id)
  );
}

// Compact, enumerated structured profile for context.
function profileLines(profile, indent = "    ") {
  if (!profile || !Object.keys(profile).length) return "";
  const lines = [];
  const fac = profile.faction;
  const facStr = fac?.name
    ? `${fac.name}${fac.rank ? ` (${fac.rank}${fac.standing ? `, ${fac.standing}` : ""})` : ""}`
    : "";
  const head = [profile.occupation ? `occupation: ${profile.occupation}` : "", facStr ? `faction: ${facStr}` : ""]
    .filter(Boolean)
    .join("; ");
  if (head) lines.push(indent + head);
  if (profile.personality?.length) lines.push(`${indent}personality: ${profile.personality.join(", ")}`);
  if (profile.speechStyle) lines.push(`${indent}speech: ${profile.speechStyle}`);
  if (profile.powers?.length)
    lines.push(
      `${indent}powers: ${profile.powers
        .map((p) => `${p.name} (${p.stat || "?"}${costStr(p.cost)})${p.summary ? ` — ${p.summary}` : ""}`)
        .join("; ")}`
    );
  if (profile.weapons?.length) lines.push(`${indent}weapons: ${profile.weapons.map((w) => w.name).join(", ")}`);
  if (profile.gear?.length) lines.push(`${indent}gear: ${profile.gear.map((g) => g.name).join(", ")}`);
  if (profile.motivations?.length) lines.push(`${indent}motivations: ${profile.motivations.join("; ")}`);
  if (profile.background) lines.push(`${indent}background: ${profile.background}`);
  return lines.join("\n");
}
function costStr(cost) {
  const e = Object.entries(cost || {});
  if (!e.length) return "";
  return "; cost " + e.map(([k, v]) => `${k}${v >= 0 ? "+" : ""}${v}`).join(", ");
}

function fmtStats(stats) {
  return Object.entries(stats || {})
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}
function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

// First sentence (or first ~140 chars) of a narration, for the anti-repetition guard (F7).
function firstSentence(text, max = 140) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0].trim() : s).slice(0, max);
}
