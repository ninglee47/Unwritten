// imagePrompt.js — centralized image-prompt composition (v0.2 §8).
// Descriptor-first consistency works with every provider (incl. keyless
// Pollinations); portrait reference images are a best-effort enhancement where
// the provider supports img2img / reference conditioning.

function styleHint(world) {
  return `Illustration for a ${world.genre} story (${world.tone}).`;
}

// Compose a scene/chapter image prompt featuring the given characters.
// `resolvePortrait(character) -> absPath|null` supplies reference images.
export function composeImagePrompt({ world, characters = [], moment = "", resolvePortrait } = {}) {
  const featured = characters.filter((c) => c && c.visualDescriptor);
  const descriptors = featured.map(
    (c) => `${c.displayName || c.name} (${c.visualDescriptor})`
  );
  const prompt = [
    moment,
    descriptors.length ? `Characters depicted — ${descriptors.join("; ")}.` : "",
    styleHint(world),
    "Cinematic, atmospheric, consistent character appearance.",
  ]
    .filter(Boolean)
    .join(" ");

  const referenceImages = resolvePortrait
    ? featured.map((c) => resolvePortrait(c)).filter(Boolean)
    : [];

  return { prompt, referenceImages };
}

// Compose a single-character portrait prompt.
export function composePortraitPrompt({ world, character }) {
  const who = character.displayName || character.name;
  const role = character.role ? `, ${character.role}` : "";
  const desc = character.visualDescriptor || "a person of this world";
  return `Character portrait of ${who}${role}: ${desc}. ${styleHint(world)} Head-and-shoulders, painterly, neutral background, consistent recognizable face.`;
}
