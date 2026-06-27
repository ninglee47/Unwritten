// activity.js — cooperative/social/daily "activity" beats (v0.2 §10A).
// The cooperative twin of the combat encounter: a sustained shared activity
// (a meal, a round of drinks, a game, music, work, rest, romance) that can span
// a few beats and resolves into social outcomes (mental-status + relationship
// shifts + witnessed memories) rather than condition damage.

export function startActivity(story, { kind = "other", participants = [], summary = "" }, resolveRef) {
  const ids = participants.map((p) => resolveRef(p)).filter(Boolean);
  story.activity = {
    active: true,
    kind,
    participants: ids,
    beat: 1,
    summary,
  };
  return story.activity;
}

export function continueActivity(story, { summary = "" } = {}) {
  if (!story.activity) return;
  story.activity.beat += 1;
  if (summary) story.activity.summary = summary;
}

// End the activity; returns a one-line result for the ledger/memory, clears it.
export function endActivity(story, { outcome = "", summary = "" } = {}) {
  const act = story.activity;
  story.activity = null;
  const kind = act?.kind || "activity";
  return `Activity (${kind}) ended: ${outcome || summary || "shared a moment"}.`;
}
