// claude.js — kept as a thin re-export of the provider facade (v0.4 §4.2).
// The Anthropic transport now lives in providers/anthropic.js and the shared
// structured pipeline in llm.js. New code should import from ./llm.js; this
// re-export keeps any older import path working with zero churn.
export {
  callGM,
  callClassify,
  callGMStructured,
  extractJSON,
  sanitizeJSON,
  setWaitHandler,
  MODEL,
  CLASSIFY_MODEL,
} from "./llm.js";
