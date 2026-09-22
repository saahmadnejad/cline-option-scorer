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

// Jev scores better with context. The payload carries the workspace root.
function contextState(event, question) {
  const roots = Array.isArray(event?.workspaceRoots) ? event.workspaceRoots : [];
  const root = event?.workspaceInfo?.rootPath || roots[0] || "";
  return typeof root === "string" && root ? `${question}\n(workspace: ${root})` : question;
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

export { main, log };

