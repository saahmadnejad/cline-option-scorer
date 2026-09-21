#!/usr/bin/env node
// PreToolUse hook: deterministically appends Jev 1.13 percentages to EVERY
// ask_question call via overrideInput. Runs before the tool executes, so it
// works no matter what the model does - no prompt mention needed.
//
// HOW CLINE DELIVERS THE TOOL INPUT (verified against Cline 3.0.62):
//   The hook runtime flattens `preToolUse.parameters` with a helper that
//   JSON.stringify()s every non-string value, so `parameters.options` arrives
//   as the STRING '["A","B"]' - never as an array. The unflattened object is
//   still present at `tool_call.input`. We prefer `tool_call.input` and fall
//   back to decoding the stringified `parameters`, so both shapes work.
//
// WHY THERE IS NO STATIC import/require OF NODE BUILTINS:
//   Cline runs this as `node <file>`. Node picks the module system from the
//   nearest package.json; there is none next to ~/.cline/hooks, so the file is
//   CommonJS and `require()` works - but the same file inside this repo would
//   be ESM ("type": "module"), where `require` throws. Dynamic import() is
//   valid in both, so the optional logging dependency is loaded lazily.
//
// Fail-open: any error returns {} (allow as-is).
// Install: `npm run install:hook` (copies to ~/.cline/hooks/PreToolUse.js,
//          chmod +x) or `cline --hooks-dir <this dir>`.
// Zero dependencies, node >= 18.

const BASE_URL = process.env.JEV_BASE_URL || "https://opencode.ai/zen/v1/systemone";
const MODEL = process.env.JEV_MODEL || "jev-1.13-free";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 10000) || 10000;

function slug(s) {
  const sl = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return (sl || "option").slice(0, 40);
}
const hasPct = (s) => /\(\d+(\.\d+)?%\)\s*$/.test(String(s));
const withPct = (o, p) => `${o} (${(p * 100).toFixed(1)}%)`;

// Undo Cline's parameter flattening: values that are JSON text get parsed back.
function decodeParams(params) {
  if (!params || typeof params !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    const t = v.trim();
    if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
      try {
        out[k] = JSON.parse(t);
        continue;
      } catch {
        /* not JSON after all: keep the raw string */
      }
    }
    out[k] = v;
  }
  return out;
}

// Raw tool input when present, else the decoded (flattened) parameters.
function readInput(event) {
  const raw = event?.tool_call?.input;
  const params = decodeParams(event?.preToolUse?.parameters);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...params, ...raw } : params;
}

// Jev scores better with context. The payload carries the workspace root.
function contextState(event, question) {
  const roots = Array.isArray(event?.workspaceRoots) ? event.workspaceRoots : [];
  const root = event?.workspaceInfo?.rootPath || roots[0] || "";
  return typeof root === "string" && root ? `${question}\n(workspace: ${root})` : question;
}

async function score(state, question, options) {
  const criteria = {};
  for (const o of options) criteria[slug(o)] = o;
  const headers = { "Content-Type": "application/json" };
  const key = process.env.OPENCODE_API_KEY || process.env.TYPESAFE_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`; // zen-free works anonymously
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      state,
      model: MODEL,
      questions: { pick: { type: "choice", instructions: question, criteria } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jev ${res.status}`);
  const ans = JSON.parse(text).answers?.pick;
  if (!ans?.probabilities) throw new Error("bad Jev response");
  const probs = {};
  for (const o of options) probs[o] = ans.probabilities[slug(o)] ?? 0;
  return probs;
}

// Best-effort JSONL audit log. Loaded lazily so the file stays valid under
// both CommonJS (~/.cline/hooks) and ESM (this repo, "type": "module").
let logSink = null;
async function log(entry) {
  try {
    if (!logSink) {
      const [fs, os] = await Promise.all([import("node:fs"), import("node:os")]);
      const home = typeof os.homedir === "function" ? os.homedir() : process.env.HOME || ".";
      const dir = process.env.CLINE_HOOK_LOG_DIR || `${home}/.cline/data/logs`;
      logSink = { fs, path: `${dir}/jev-hook.jsonl` };
    }
    logSink.fs.appendFileSync(logSink.path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* logging is observational only */
  }
}

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({})); // unparsable input: allow
    return;
  }
  const toolName = event?.preToolUse?.toolName || event?.tool_call?.name || "";
  if (!/^ask_(question|followup_question)$/i.test(toolName)) {
    console.log(JSON.stringify({})); // not a question: ignore
    return;
  }
  const input = readInput(event);
  const question = input.question;
  const options = input.options;
  if (typeof question !== "string" || !Array.isArray(options) || !options.every((o) => typeof o === "string")) {
    console.log(JSON.stringify({})); // unexpected shape: allow as-is
    return;
  }
  if (options.length < 2) {
    await log({ event: "skip", reason: "single_option" });
    console.log(JSON.stringify({})); // nothing to score
    return;
  }
  if (options.some(hasPct)) {
    await log({ event: "skip", reason: "already_enriched" });
    console.log(JSON.stringify({})); // idempotent: never double-tag
    return;
  }
  await log({ event: "intercept", tool: toolName, source: "hook", question, options });
  try {
    const probs = await score(contextState(event, question), question, options);
    const enriched = options.map((o) => withPct(o, probs[o]));
    await log({ event: "enriched", source: "hook", question, enriched });
    console.log(JSON.stringify({ cancel: false, overrideInput: { ...input, question, options: enriched } }));
  } catch (e) {
    console.error(`[jev-percent] scoring failed, allowing as-is: ${e?.message || e}`);
    await log({ event: "fail_open", source: "hook", error: String(e?.message || e) });
    console.log(JSON.stringify({}));
  }
}

main().catch(async (e) => {
  await log({ event: "fail_open", source: "hook", error: `unhandled: ${e?.message || e}` });
  console.log(JSON.stringify({})); // never let the hook block a tool call
});
