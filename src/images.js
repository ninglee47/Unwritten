// images.js — pluggable image-render adapter (Technical Spec §9).
// Claude generates the PROMPT; rendering is optional and provider-driven.
import fs from "fs";
import path from "path";

const PROVIDER = () => (process.env.IMAGE_PROVIDER || "none").toLowerCase();
const TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 30000);

// Typed image error so the render queue can decide retry-vs-give-up and honor
// Retry-After (v0.3 §4.3).
export class ImageError extends Error {
  constructor(message, { status, retryAfterMs, fatal } = {}) {
    super(message);
    this.name = "ImageError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.fatal = !!fatal;
  }
}

// Build a typed error from a non-OK HTTP response (parses Retry-After: seconds
// or HTTP-date). 4xx other than 429 is fatal (won't fix on retry).
function httpError(res) {
  const status = res.status;
  let retryAfterMs;
  const ra = res.headers?.get?.("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) retryAfterMs = Math.max(0, secs * 1000);
    else {
      const when = Date.parse(ra);
      if (!Number.isNaN(when)) retryAfterMs = Math.max(0, when - Date.now());
    }
  }
  const fatal = status >= 400 && status < 500 && status !== 429;
  return new ImageError(`HTTP ${status}`, { status, retryAfterMs, fatal });
}

// fetch with an AbortController timeout so a slow/hung provider can't stall the
// caller indefinitely. On timeout it throws and the caller falls back to a
// placeholder (the on-demand render path retries later).
async function fetchT(url, opts = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    // timeouts / network errors are transient (retryable), not fatal
    if (err.name === "AbortError") throw new ImageError(`timed out after ${ms}ms`, {});
    throw new ImageError(err.message || "network error", {});
  } finally {
    clearTimeout(t);
  }
}

// Render `prompt` to `outPath` (a .png). Returns the path on success, or null
// if rendering was skipped/failed (caller falls back to a placeholder).
// `opts.referenceImages` (absolute paths) are used by providers that support
// reference / img2img conditioning, and ignored by those that don't (v0.2 §8).
// Throws a typed ImageError on failure (so the render queue can classify and
// retry); returns null only when there is nothing to render (provider none /
// no prompt / unknown provider).
export async function renderImage(prompt, outPath, opts = {}) {
  const provider = PROVIDER();
  if (provider === "none" || !prompt) return null;
  const refs = (opts.referenceImages || []).filter((p) => p && fs.existsSync(p));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  switch (provider) {
    case "pollinations":
      return await pollinations(prompt, outPath); // text-only; descriptor consistency
    case "cloudflare":
      return await cloudflare(prompt, outPath);
    case "huggingface":
      return await huggingface(prompt, outPath);
    case "gemini":
      return await gemini(prompt, outPath, refs); // can use reference images
    default:
      return null;
  }
}

async function writeBuf(outPath, arrayBuffer) {
  fs.writeFileSync(outPath, Buffer.from(arrayBuffer));
  return outPath;
}

// Keyless, URL-based (easiest free option).
async function pollinations(prompt, outPath) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
    prompt
  )}?width=768&height=768&nologo=true`;
  const res = await fetchT(url);
  if (!res.ok) throw httpError(res);
  return writeBuf(outPath, await res.arrayBuffer());
}

// Cloudflare Workers AI (FLUX). Needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN.
async function cloudflare(prompt, outPath) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) throw new ImageError("missing Cloudflare credentials", { fatal: true });
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  const res = await fetchT(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw httpError(res);
  const data = await res.json();
  // FLUX schnell returns base64 in data.result.image
  const b64 = data?.result?.image;
  if (!b64) throw new ImageError("no image in response", { fatal: true });
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  return outPath;
}

// Hugging Face Inference API. Needs HUGGINGFACE_TOKEN.
async function huggingface(prompt, outPath) {
  const token = process.env.HUGGINGFACE_TOKEN;
  if (!token) throw new ImageError("missing HUGGINGFACE_TOKEN", { fatal: true });
  const url =
    "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell";
  const res = await fetchT(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: prompt }),
  });
  if (!res.ok) throw httpError(res);
  return writeBuf(outPath, await res.arrayBuffer());
}

// Google Gemini image. Needs GEMINI_API_KEY. Model is overridable via
// GEMINI_IMAGE_MODEL since Google rotates these names. Supports reference
// images (passed as inline image parts) for character consistency (v0.2 §8).
async function gemini(prompt, outPath, referenceImages = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ImageError("missing GEMINI_API_KEY", { fatal: true });
  // ⚠️ Must be an IMAGE model (gemini-2.5-flash-image), NOT gemini-2.5-flash
  // (which returns text). Google rotates these names → override via env.
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const parts = [{ text: prompt }];
  for (const ref of (referenceImages || []).slice(0, 3)) {
    try {
      const b64 = fs.readFileSync(ref).toString("base64");
      parts.push({ inlineData: { mimeType: "image/png", data: b64 } });
    } catch {
      /* skip unreadable reference */
    }
  }
  const res = await fetchT(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      // this model requires BOTH modalities; IMAGE-only is rejected.
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  if (!res.ok) throw httpError(res);
  const data = await res.json();
  const outParts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = outParts.find((p) => p.inlineData?.data);
  if (!imgPart) throw new ImageError("no image in response", { fatal: true });
  fs.writeFileSync(outPath, Buffer.from(imgPart.inlineData.data, "base64"));
  return outPath;
}
