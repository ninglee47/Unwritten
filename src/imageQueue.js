// imageQueue.js — background image render queue (v0.3 §4.3).
// Renders never run inside an HTTP request: routes enqueue a job and return a
// "generating" placeholder immediately, then the client polls for "ready".
// One in-flight attempt per key, a small global concurrency cap, and rate-limit
// aware retry (honors Retry-After) so a 429 can never storm the provider.
import { renderImage } from "./images.js";

const CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY || 2);
const MAX_RETRIES = Number(process.env.IMAGE_MAX_RETRIES || 4);
const RETRY_TOTAL_MS = Number(process.env.IMAGE_RETRY_TOTAL_MS || 300000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// key -> { status: pending|rendering|ready|failed, job, onReady }
const jobs = new Map();
let active = 0;

export function imageStatus(key) {
  return jobs.get(key)?.status || "absent";
}

// Enqueue a render (idempotent per key). Returns the current status. Once a job
// exists (pending/rendering/ready/failed) it is NOT re-enqueued — `failed` is
// terminal for this session (a server restart clears the map and retries),
// which prevents a 429/error storm under repeated panel re-renders (§4.5).
export function enqueueImage(key, { prompt, outPath, referenceImages = [], onReady } = {}) {
  const existing = jobs.get(key);
  if (existing) return existing.status;
  if (!prompt) return "absent";
  const entry = { status: "pending", onReady };
  entry.job = () => runJob(key, entry, { prompt, outPath, referenceImages });
  jobs.set(key, entry);
  schedule();
  return "pending";
}

function schedule() {
  for (const entry of jobs.values()) {
    if (active >= CONCURRENCY) break;
    if (entry.status === "pending" && entry.job) {
      entry.status = "rendering";
      const job = entry.job;
      entry.job = null;
      active++;
      job().finally(() => {
        active--;
        schedule();
      });
    }
  }
}

async function runJob(key, entry, { prompt, outPath, referenceImages }) {
  const deadline = Date.now() + RETRY_TOTAL_MS;
  let attempt = 0;
  while (true) {
    try {
      const out = await renderImage(prompt, outPath, { referenceImages });
      if (out) {
        entry.status = "ready";
        try {
          entry.onReady?.(out);
        } catch (e) {
          console.warn(`[imageQueue] ${key} onReady error: ${e.message}`);
        }
      } else {
        entry.status = "failed"; // nothing to render (provider none / skip)
      }
      return;
    } catch (err) {
      if (err.fatal) {
        entry.status = "failed";
        console.warn(`[imageQueue] ${key} fatal: ${err.message}`);
        return;
      }
      attempt++;
      if (attempt > MAX_RETRIES || Date.now() >= deadline) {
        entry.status = "failed";
        console.warn(`[imageQueue] ${key} gave up after ${attempt} attempt(s): ${err.message}`);
        return;
      }
      const backoff =
        err.retryAfterMs != null
          ? err.retryAfterMs
          : Math.min(30000, 2 ** attempt * 1000 + Math.random() * 1000);
      const wait = Math.min(backoff, Math.max(0, deadline - Date.now()));
      console.warn(
        `[imageQueue] ${key} ${err.message} — retry ${attempt}/${MAX_RETRIES} in ${Math.round(wait / 1000)}s`
      );
      await sleep(wait);
    }
  }
}
