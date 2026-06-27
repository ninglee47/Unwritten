// llm.js — provider-agnostic LLM facade (v0.4 §4.2).
// Owns everything the game depends on that is NOT provider-specific:
//   - the structured-output pipeline (extractJSON / sanitizeJSON / zod validate /
//     self-correcting retry)
//   - the rate-limit / credit backoff loop
// and dispatches the low-level generate() to the provider selected by
// LLM_PROVIDER (anthropic kept live as a fallback). Call sites import
// callGM / callClassify / callGMStructured from here; the names are identical
// to the old claude.js so nothing else changes.
import * as anthropic from "./providers/anthropic.js";
import * as gemini from "./providers/gemini.js";

const PROVIDERS = { anthropic, gemini };

export function activeProviderName() {
  return (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
}
function provider() {
  return PROVIDERS[activeProviderName()] || anthropic;
}

// The provider to fall back to when the active one is unavailable (v0.4).
// LLM_FALLBACK: "auto" (default) = the other provider IF its key is set;
// a provider name to force one; "off"/"none" to disable. Falls back only on
// retryable failures (transient / rate-limit / credit), never on fatal errors.
function fallbackProvider() {
  const setting = (process.env.LLM_FALLBACK || "auto").toLowerCase();
  if (setting === "off" || setting === "none") return null;
  const active = activeProviderName();
  const name = setting === "auto" || setting === "" ? (active === "gemini" ? "anthropic" : "gemini") : setting;
  if (name === active) return null;
  const prov = PROVIDERS[name];
  if (!prov) return null;
  const hasKey = name === "gemini" ? !!process.env.GEMINI_API_KEY : !!process.env.ANTHROPIC_API_KEY;
  return hasKey ? prov : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional hook so the server/UI can show a "waiting for capacity/credit" state.
let _waitHandler = null;
export function setWaitHandler(fn) {
  _waitHandler = fn;
}
function notifyWait(info) {
  const secs = Math.round((info.waitMs || 0) / 1000);
  console.warn(
    `[llm:${info.provider || activeProviderName()}] ${info.category} — waiting ${secs}s before retry${info.attempt ? ` (attempt ${info.attempt})` : ""}…`
  );
  try {
    _waitHandler?.(info);
  } catch {
    /* ignore */
  }
}

// ---- provider-neutral backoff loop (generalizes v0.2 §11) ------------------
// Reads LLM_* config, falling back to the old CLAUDE_* keys for compatibility.
function cfg(llmKey, claudeKey, dflt) {
  return Number(process.env[llmKey] ?? process.env[claudeKey] ?? dflt);
}
async function withRetry(doCall, prov) {
  const maxRetries = cfg("LLM_MAX_RETRIES", "CLAUDE_MAX_RETRIES", 5);
  const maxBackoff = cfg("LLM_MAX_BACKOFF_MS", "CLAUDE_MAX_BACKOFF_MS", 60000);
  const creditEvery = cfg("LLM_CREDIT_RETRY_MS", "CLAUDE_CREDIT_RETRY_MS", 30000);
  const creditTotal = cfg("LLM_CREDIT_RETRY_TOTAL_MS", "CLAUDE_CREDIT_RETRY_TOTAL_MS", 600000);

  let attempt = 0;
  let creditElapsed = 0;
  while (true) {
    try {
      return await doCall();
    } catch (err) {
      const { category, retryAfterMs } = prov.classifyError(err);
      if (category === "fatal") throw err;

      if (category === "credit") {
        if (creditElapsed >= creditTotal) {
          err.retryable = true;
          err.reason = "credit";
          throw err;
        }
        const wait = retryAfterMs ?? creditEvery;
        creditElapsed += wait;
        notifyWait({ category, waitMs: wait, provider: prov.name });
        await sleep(wait);
        continue;
      }

      // transient / rate_limit
      attempt++;
      if (attempt > maxRetries) {
        err.retryable = true;
        err.reason = category;
        throw err;
      }
      const backoff =
        retryAfterMs != null
          ? Math.min(retryAfterMs, maxBackoff)
          : Math.min(maxBackoff, 2 ** attempt * 500 + Math.random() * 500);
      notifyWait({ category, waitMs: backoff, attempt, provider: prov.name });
      await sleep(backoff);
    }
  }
}

// Run a generation against the active provider with backoff; if it exhausts the
// budget on a RETRYABLE failure and a fallback provider is configured, try the
// fallback once (v0.4 — "keep Claude live as a fallback"). `genFor(prov)` builds
// the call for a given provider module.
async function withFallback(genFor) {
  const primary = provider();
  try {
    return await withRetry(() => genFor(primary), primary);
  } catch (err) {
    const fb = fallbackProvider();
    if (err.retryable && fb && fb.name !== primary.name) {
      console.warn(
        `[llm] ${primary.name} unavailable (${err.reason}) after retries — falling back to ${fb.name} for this call.`
      );
      return await withRetry(() => genFor(fb), fb);
    }
    throw err;
  }
}

// ---- public text calls (same signatures as the old claude.js) --------------
export async function callGM(systemPrompt, messages, max_tokens = 1500) {
  return withFallback((prov) =>
    prov.generate({ system: systemPrompt, messages, maxTokens: max_tokens, kind: "gm" })
  );
}

export async function callClassify(systemPrompt, userText, max_tokens = 400) {
  return withFallback((prov) =>
    prov.generate({
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
      maxTokens: max_tokens,
      kind: "classify",
    })
  );
}

// ---- shared JSON pipeline (provider-neutral) -------------------------------
function balancedObject(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

// Repair common model JSON quirks WITHOUT touching string contents:
//  - unquoted signed numbers ("Stress": +10 → "Stress": 10)
//  - trailing commas before } or ]
export function sanitizeJSON(s) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "+" && /\d/.test(s[i + 1] || "")) continue;
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function tryParse(candidate) {
  if (!candidate) return null;
  for (const variant of [candidate, sanitizeJSON(candidate)]) {
    try {
      return JSON.parse(variant.trim());
    } catch {
      /* try next */
    }
  }
  return null;
}

// Extract a JSON object from model text. Handles native JSON mode (a bare
// object), fenced ```json blocks, and brace-balanced objects with trailing prose.
export function extractJSON(text) {
  if (!text) return null;
  const candidates = [];
  const fencedJson = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson) candidates.push(fencedJson[1]);
  const fencedAny = text.match(/```\s*([\s\S]*?)```/);
  if (fencedAny) candidates.push(fencedAny[1]);
  const first = text.indexOf("{");
  if (first !== -1) candidates.push(balancedObject(text, first));

  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

const DEBUG = () => process.env.DEBUG_LLM === "1" || process.env.DEBUG_CLAUDE === "1";

function diagnose(parsed, result) {
  if (!parsed) return "could not extract JSON object from the reply";
  if (result && !result.success) {
    const issues = result.error?.issues || [];
    return (
      "schema validation failed: " +
      issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
    );
  }
  return "unknown";
}

// One structured generation (with native JSON mode where the provider supports
// it), through the same retry + provider-fallback path as the other calls.
function genStructured(systemPrompt, messages, max_tokens) {
  return withFallback((prov) =>
    prov.generate({
      system: systemPrompt,
      messages,
      maxTokens: max_tokens,
      kind: "gm",
      json: true,
    })
  );
}

// Call the active provider and parse + validate the JSON response, with one
// self-correcting retry on parse/validation failure (the backoff loop above
// separately handles rate-limit/credit failures of each underlying call).
export async function callGMStructured(systemPrompt, messages, schema, max_tokens = 3000) {
  const raw = await genStructured(systemPrompt, messages, max_tokens);
  let parsed = extractJSON(raw);
  let result = parsed ? schema.safeParse(parsed) : { success: false };

  if (!result.success) {
    const reason1 = diagnose(parsed, result);
    if (DEBUG()) {
      console.error("[llm] structured parse failed:", reason1);
      console.error("[llm] raw reply (first 1200 chars):\n" + raw.slice(0, 1200));
    }
    const fixMessages = [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content:
          "Your previous reply could not be used (" +
          reason1 +
          "). Reply again with ONLY a single JSON object that strictly matches the required schema. Use plain JSON numbers (e.g. 10 or -5, never +10), no comments, no trailing commas, and no text outside the JSON.",
      },
    ];
    const raw2 = await genStructured(systemPrompt, fixMessages, max_tokens);
    parsed = extractJSON(raw2);
    result = parsed ? schema.safeParse(parsed) : { success: false };
    if (!result.success) {
      const reason2 = diagnose(parsed, result);
      if (DEBUG()) {
        console.error("[llm] retry parse failed:", reason2);
        console.error("[llm] raw retry (first 1200 chars):\n" + raw2.slice(0, 1200));
      }
      throw new Error(
        `LLM returned unparseable structured output after retry (${reason2}). Set DEBUG_LLM=1 to log the raw reply.`
      );
    }
  }
  return result.data;
}

// Backwards-compatible model accessors (some callers/logging used these).
export const MODEL = () => provider().modelLabel("gm");
export const CLASSIFY_MODEL = () => provider().modelLabel("classify");
