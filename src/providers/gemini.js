// providers/gemini.js — low-level Google Gemini transport (v0.4).
// REST `generateContent` (no extra dependency; mirrors how images.js already
// calls Gemini). Implements the same provider interface as anthropic.js.
export const name = "gemini";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    const e = new Error(
      "GEMINI_API_KEY is not set. Add it to .env (or set LLM_PROVIDER=anthropic to use Claude)."
    );
    e.fatal = true; // config error — never retry
    throw e;
  }
  return k;
}

const GM_MODEL = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CLASSIFY_MODEL = () => process.env.GEMINI_CLASSIFY_MODEL || "gemini-2.5-flash-lite";

export function modelLabel(kind = "gm") {
  return kind === "classify" ? CLASSIFY_MODEL() : GM_MODEL();
}

// Relaxed-but-policy-bound safety thresholds so the game's own content
// boundaries (Product Spec §6.4) remain the primary gate (v0.4 §4.6).
function safetySettings() {
  if ((process.env.GEMINI_SAFETY || "default").toLowerCase() !== "relaxed") return undefined;
  return [
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
  ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));
}

async function fetchT(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    const e = new Error(err.name === "AbortError" ? "Gemini request timed out" : err.message);
    e.transient = true;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// A single generation attempt (no retry — llm.js wraps with backoff).
export async function generate({ system, messages, maxTokens = 1500, kind = "gm", json = false }) {
  const key = apiKey();
  const model = kind === "classify" ? CLASSIFY_MODEL() : GM_MODEL();

  // Map Anthropic-style messages → Gemini contents (assistant → model).
  const contents = (messages || []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }],
  }));

  // F5: on gemini-2.5-flash, internal "thinking" tokens share the output budget,
  // so the tail of a large deltas JSON (scene.present, chapterShouldEnd,
  // suggestedActions) gets truncated → zod defaults silently mask the loss.
  // Give the GM a generous output floor and BOUND thinking so it can't starve
  // the answer; on a MAX_TOKENS truncation, bump the budget and retry once.
  const FLOOR = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 8192);
  const THINK_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET || 1024);
  let outBudget = kind === "classify" ? maxTokens : Math.max(maxTokens, FLOOR);

  for (let attempt = 0; attempt < 2; attempt++) {
    const generationConfig = {
      maxOutputTokens: outBudget,
      temperature: kind === "classify" ? 0.2 : 0.9,
    };
    if (json) generationConfig.responseMimeType = "application/json";
    if (kind === "classify") {
      generationConfig.thinkingConfig = { thinkingBudget: 0 }; // classifier: speed
    } else {
      const thinking = (process.env.GEMINI_THINKING || "on").toLowerCase();
      generationConfig.thinkingConfig = { thinkingBudget: thinking === "off" ? 0 : THINK_BUDGET };
    }

    const body = { contents, generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const safety = safetySettings();
    if (safety) body.safetySettings = safety;

    const res = await fetchT(`${API}/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const e = new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
      e.status = res.status;
      e.body = errText;
      throw e;
    }

    const data = await res.json();
    const cand = data?.candidates?.[0];
    if (!cand) {
      // No candidate → usually a prompt-level safety block; fail fast (not retryable).
      const reason = data?.promptFeedback?.blockReason;
      const e = new Error(`Gemini returned no candidate${reason ? ` (blocked: ${reason})` : ""}`);
      e.fatal = true;
      throw e;
    }
    const text = (cand.content?.parts || []).map((p) => p.text || "").join("");

    // Truncated by the token cap → bump the budget and retry once before giving up.
    if (cand.finishReason === "MAX_TOKENS" && attempt === 0) {
      outBudget = Math.min(outBudget * 2, 32768);
      console.warn(`[gemini] MAX_TOKENS truncation — retrying with ${outBudget} output tokens…`);
      continue;
    }
    if (!text) {
      const e = new Error(`Gemini empty reply (finishReason: ${cand.finishReason || "unknown"})`);
      e.transient = true;
      throw e;
    }
    return text;
  }

  const e = new Error("Gemini reply still truncated (MAX_TOKENS) after budget bump");
  e.transient = true;
  throw e;
}

// Classify a Gemini error into a retry bucket (v0.4 §4.5).
export function classifyError(err) {
  if (err?.fatal) return { category: "fatal" }; // config / prompt-blocked → never retry
  const status = err?.status;
  const body = (err?.body || err?.message || "").toLowerCase();

  if (status === 429 || /resource_exhausted/.test(body)) {
    // honor a retryDelay hint from the error details if present
    let retryAfterMs;
    const m = body.match(/"?retrydelay"?\s*:?\s*"?(\d+)s/);
    if (m) retryAfterMs = Number(m[1]) * 1000;
    // a daily/quota exhaustion that isn't a momentary rate limit → credit bucket
    if (/quota.*exceed|billing|daily limit|per day/.test(body))
      return { category: "credit", retryAfterMs };
    return { category: "rate_limit", retryAfterMs };
  }
  if (status === 400 || status === 401 || status === 403 ||
      /invalid_argument|permission_denied|api key|unauthenticated/.test(body))
    return { category: "fatal" };
  if (err?.transient || status === undefined || status === 500 || status === 503 ||
      /unavailable|internal|timeout|network|fetch failed|econn|socket/.test(body))
    return { category: "transient" };
  return { category: "fatal" };
}
