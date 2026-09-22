// jev-hook-core.js (part 1): scoring + payload helpers. No imports — builtins
// come via __req, config via resolveConfig (both defined in src/jev-config.js,
// which concatenates BEFORE this file in the generated CJS lib).
//
// HOW CLINE DELIVERS THE TOOL INPUT (verified against Cline 3.0.62):
//   The hook runtime flattens `preToolUse.parameters` with a helper that
//   JSON.stringify()s every non-string value, so `parameters.options` arrives
//   as the STRING '["A","B"]' - never as an array. The unflattened object is
//   still present at `tool_call.input`. We prefer `tool_call.input` and fall
//   back to decoding the stringified `parameters`, so both shapes work.
function slug(s) {
  const sl = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return (sl || "option").slice(0, 40);
}
const hasPct = (s) => /\(\d+(\.\d+)?%\)\s*$/.test(String(s));
const withPct = (o, p) => `${o} (${(p * 100).toFixed(1)}%)`;
const PROVIDERS = {
  typesafe: { baseUrl: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  zen: { baseUrl: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" },
  "zen-free": { baseUrl: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13-free" },
};

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

// Jev scores better with context. The payload carries the workspace root plus
// recent decisions (question → chosen answer) captured by the PostToolUse hook.
function contextState(event, question) {
  const roots = Array.isArray(event?.workspaceRoots) ? event.workspaceRoots : [];
  const root = event?.workspaceInfo?.rootPath || roots[0] || "";
  return typeof root === "string" && root ? `${question}\n(workspace: ${root})` : question;
}

const trunc = (s, n) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

// Read the audit trail and pair past questions with the answers the user
// actually gave (PostToolUse logs `answer` events). Returns "" when history is
// disabled, missing, or unparseable — enrichment must never break scoring.
function buildHistory(cfg) {
  if (cfg.includeHistory === false) return "";
  try {
    const fs = __req("node:fs");
    const os = __req("node:os");
    const logDir = cfg.logDir || `${os.homedir()}/.cline/data/logs`;
    const raw = fs.readFileSync(`${logDir}/jev-hook.jsonl`, "utf8");
    const entries = [];
    for (const line of raw.split("\n").slice(-400)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    // Pair each `intercept` with the next `answer` for the same question.
    const pairs = [];
    let lastQ = null;
    for (const e of entries) {
      if (e?.event === "intercept" && typeof e.question === "string") {
        lastQ = e;
      } else if (e?.event === "answer" && typeof e.question === "string" && e.answer && lastQ?.question === e.question) {
        pairs.push([lastQ.question, e.answer]);
        lastQ = null;
      }
    }
    const turns = Math.max(0, Number(cfg.historyTurns) | 0);
    if (turns === 0) return ""; // NB: `slice(-0)` would return the WHOLE array
    let budget = Math.max(0, (cfg.maxStateChars ?? 2000) - 400); // keep room for question + workspace
    const lines = [];
    for (const [q, a] of pairs.slice(-turns).reverse()) {
      const line = `Q: ${trunc(q, 160)} → chose: ${trunc(a, 80)}`;
      if (line.length > budget) break;
      lines.push(line);
      budget -= line.length + 1;
    }
    return lines.length ? `\nRecent decisions in this session:\n${lines.join("\n")}` : "";
  } catch {
    return ""; // no trail yet / unreadable: score without history
  }
}

// The full `state` payload: question + workspace + (optional) decision history.
function buildState(event, question) {
  const cfg = resolveConfig();
  let state = contextState(event, question) + buildHistory(cfg);
  const max = cfg.maxStateChars ?? 2000;
  if (state.length > max) state = state.slice(0, max);
  return state;
}

async function score(state, question, options) {
  const cfg = resolveConfig();
  const known = PROVIDERS[cfg.provider] || PROVIDERS["zen-free"];
  const criteria = {};
  for (const o of options) criteria[slug(o)] = o;
  const headers = { "Content-Type": "application/json" };
  const key = cfg.opencodeApiKey || cfg.typesafeApiKey;
  if (key) headers.Authorization = `Bearer ${key}`; // zen-free works anonymously
  const res = await fetch(cfg.baseUrl || known.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      state,
      model: cfg.model || known.model,
      questions: { pick: { type: "choice", instructions: question, criteria } },
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jev ${res.status}`);
  const ans = JSON.parse(text).answers?.pick;
  if (!ans?.probabilities) throw new Error("bad Jev response");
  const probs = {};
  for (const o of options) probs[o] = ans.probabilities[slug(o)] ?? 0;
  return probs;
}

// Best-effort JSONL audit log. Builtins come via __req (defined by the ESM
// source's createRequire bootstrap, or the generated CJS header) so this file
// has no static imports and stays loadable as CJS *and* ESM.
let logSink = null;
async function log(entry, deps) {
  try {
    if (!logSink) {
      const fs = deps?.fs || __req("node:fs");
      const os = __req("node:os");
      // The audit dir comes from cline-jev.json (`logDir`), never from the env.
      const cfg = resolveConfig();
      const dir = deps?.logDir || cfg.logDir || `${os.homedir()}/.cline/data/logs`;
      // A fresh logDir does not exist yet; without this every write fails
      // silently and the decision history would never populate.
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
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
    const probs = await score(buildState(event, question), question, options);
    const enriched = options.map((o) => withPct(o, probs[o]));
    await log({ event: "enriched", source: "hook", question, enriched });
    console.log(JSON.stringify({ cancel: false, overrideInput: { ...input, question, options: enriched } }));
  } catch (e) {
    console.error(`[jev-percent] scoring failed, allowing as-is: ${e?.message || e}`);
    await log({ event: "fail_open", source: "hook", error: String(e?.message || e) });
    console.log(JSON.stringify({}));
  }
}

/* ---------- PostToolUse: capture the chosen answer ---------- */

// The exact PostToolUse payload shape is not pinned down yet, so look in every
// plausible place for the user's answer. Anything object-shaped is probed for
// common field names; we never dump whole objects into the trail.
function stringifyAnswer(v, depth = 0) {
  if (v == null || depth > 2) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const xml = t.match(/<answer>([\s\S]*?)<\/answer>/i); // Cline's followup XML form
    return trunc(xml ? xml[1] : t, 300);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    for (const k of ["answer", "text", "content", "response", "output", "result", "selectedOption", "selected", "message", "value"]) {
      const s = stringifyAnswer(v[k], depth + 1);
      if (s) return s;
    }
  }
  return null;
}

function extractAnswer(event) {
  const tool = event?.tool_call || {};
  const post = event?.postToolUse || {};
  for (const raw of [tool.response, tool.result, tool.output, tool.answer, post.response, post.result, post.output, post.answer, post.parameters]) {
    const s = stringifyAnswer(raw);
    if (s) return s;
  }
  return null;
}

// Fires AFTER ask_question/ask_followup_question completes. Observes only —
// always responds {} so the tool result is never modified. The captured
// question→answer pair is what the next PreToolUse scoring reads as history.
async function postMain() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }
  const toolName = event?.postToolUse?.toolName || event?.tool_call?.name || "";
  if (!/^ask_(question|followup_question)$/i.test(toolName)) {
    console.log(JSON.stringify({}));
    return;
  }
  const input = readInput(event);
  const question = typeof input?.question === "string" ? input.question : "";
  const answer = extractAnswer(event);
  if (answer) {
    await log({ event: "answer", source: "hook", tool: toolName, question, answer });
  } else {
    // Self-debugging: if the shape ever changes, the trail tells us where to look.
    await log({
      event: "answer_unclear",
      source: "hook",
      tool: toolName,
      question,
      eventKeys: Object.keys(event || {}),
      toolCallKeys: Object.keys(event?.tool_call || {}),
      postToolUseKeys: Object.keys(event?.postToolUse || {}),
    });
  }
  console.log(JSON.stringify({}));
}

export { main, postMain, log };

