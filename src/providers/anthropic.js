// providers/anthropic.js — low-level Anthropic transport (moved from claude.js).
// Implements the provider interface the llm.js facade expects:
//   generate({ system, messages, maxTokens, kind, json }) -> reply text
//   classifyError(err) -> { category, retryAfterMs }
// The shared JSON pipeline + backoff retry live in llm.js (provider-neutral).
import Anthropic from "@anthropic-ai/sdk";

export const name = "anthropic";

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      const e = new Error(
        "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key (or set LLM_PROVIDER=gemini)."
      );
      e.fatal = true; // config error — never retry
      throw e;
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const MODEL = () => process.env.MODEL || "claude-sonnet-4-6";
const CLASSIFY_MODEL = () =>
  process.env.CLASSIFY_MODEL || "claude-haiku-4-5-20251001";

export function modelLabel(kind = "gm") {
  return kind === "classify" ? CLASSIFY_MODEL() : MODEL();
}

// A single generation attempt (no retry — llm.js wraps with backoff).
// `json` is ignored: Anthropic has no native JSON mode; the prompt's
// "emit one json block" instruction + the shared extractor handle it.
export async function generate({ system, messages, maxTokens = 1500, kind = "gm" }) {
  const params = {
    model: kind === "classify" ? CLASSIFY_MODEL() : MODEL(),
    max_tokens: maxTokens,
    messages,
  };
  if (system) params.system = system;
  const res = await client().messages.create(params);
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

// Classify an Anthropic error into a retry bucket (v0.2 §11.3).
export function classifyError(err) {
  if (err?.fatal) return { category: "fatal" }; // config error → never retry
  const status = err?.status;
  const type = err?.error?.type || err?.error?.error?.type || err?.type || "";
  const msg = (err?.message || "").toLowerCase();

  let retryAfterMs;
  const h = err?.headers;
  let ra;
  if (h && typeof h.get === "function") ra = h.get("retry-after");
  else if (h) ra = h["retry-after"];
  const n = Number(ra);
  if (Number.isFinite(n) && n >= 0) retryAfterMs = n * 1000;

  if (status === 429 || type === "rate_limit_error")
    return { category: "rate_limit", retryAfterMs };
  if (
    status === 402 ||
    type === "billing" ||
    /credit|billing|quota|insufficient|payment required|spend/.test(msg)
  )
    return { category: "credit" };
  if (
    status === undefined ||
    status >= 500 ||
    type === "overloaded_error" ||
    err?.name === "APIConnectionError" ||
    err?.name === "APIConnectionTimeoutError" ||
    /timeout|network|fetch failed|econn|socket/.test(msg)
  )
    return { category: "transient" };
  return { category: "fatal" };
}
