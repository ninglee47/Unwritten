// placeholder.js — SVG placeholder served when no chapter image is rendered
// (IMAGE_PROVIDER=none). Keeps the gallery working with zero dependencies.
export function placeholderSVG(caption = "Chapter") {
  const safe = String(caption)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 768" width="768" height="768">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b2233"/>
      <stop offset="1" stop-color="#7c3f2e"/>
    </linearGradient>
  </defs>
  <rect width="768" height="768" fill="url(#g)"/>
  <g fill="#e8e0d5" opacity="0.9" text-anchor="middle" font-family="Georgia, serif">
    <text x="384" y="360" font-size="120" opacity="0.25">✦</text>
    <text x="384" y="470" font-size="34">${safe}</text>
    <text x="384" y="510" font-size="18" opacity="0.7">illustration pending</text>
  </g>
</svg>`;
}

const ESC = (s) =>
  String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// "Generating…" placeholder with a subtle shimmer (v0.3 §4.4).
export function generatingSVG(caption = "Illustration") {
  const safe = ESC(caption).slice(0, 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 768" width="768" height="768">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241d2e"/><stop offset="1" stop-color="#3a2a3a"/>
    </linearGradient>
    <linearGradient id="sh" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="-1 0" to="1 0" dur="1.6s" repeatCount="indefinite"/>
    </linearGradient>
  </defs>
  <rect width="768" height="768" fill="url(#bg)"/>
  <rect width="768" height="768" fill="url(#sh)"/>
  <g fill="#e8e0d5" text-anchor="middle" font-family="-apple-system, Georgia, serif">
    <text x="384" y="372" font-size="76" opacity="0.5">✦</text>
    <text x="384" y="452" font-size="26" opacity="0.85">${safe}</text>
    <text x="384" y="492" font-size="17" opacity="0.6">illustration generating…</text>
  </g>
</svg>`;
}

// Terminal "unavailable" placeholder after the retry budget is exhausted.
export function unavailableSVG(caption = "Illustration") {
  const safe = ESC(caption).slice(0, 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 768" width="768" height="768">
  <rect width="768" height="768" fill="#221c2c"/>
  <g fill="#9d92ad" text-anchor="middle" font-family="-apple-system, Georgia, serif">
    <text x="384" y="372" font-size="72" opacity="0.4">⌧</text>
    <text x="384" y="452" font-size="24">${safe}</text>
    <text x="384" y="490" font-size="16" opacity="0.7">illustration unavailable</text>
  </g>
</svg>`;
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

// Deterministic portrait placeholder from initials + a colour derived from the
// name (so each character gets a stable, distinct chip) — v0.2 §7.2.
export function portraitPlaceholderSVG(name = "?", descriptor = "") {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const c1 = `hsl(${h} 35% 28%)`;
  const c2 = `hsl(${(h + 40) % 360} 45% 22%)`;
  const desc = ESC(descriptor).slice(0, 70);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#p)"/>
  <circle cx="256" cy="210" r="92" fill="#ffffff" opacity="0.10"/>
  <text x="256" y="246" font-size="120" fill="#ece6f0" opacity="0.85" text-anchor="middle" font-family="Georgia, serif">${ESC(initials(name))}</text>
  <text x="256" y="430" font-size="22" fill="#ece6f0" opacity="0.7" text-anchor="middle" font-family="-apple-system, sans-serif">${desc}</text>
</svg>`;
}
