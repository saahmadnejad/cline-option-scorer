// jev-hook-core.js (part 1): scoring + payload helpers.
// Builtins come via __req, config via resolveConfig. In the generated CJS lib
// both are supplied by the concatenation of src/jev-config.js; when this file is
// loaded as ESM (mcp-server.js does) the two lines below provide them. The
// installer strips both lines, so nothing is ever declared twice.
import { createRequire as __createRequire } from "node:module";
import { resolveConfig } from "./jev-config.js";
const __req = typeof require === "function" ? require : __createRequire(import.meta.url);
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
// PreToolUse delivers the tool input as `preToolUse.parameters`, PostToolUse as
// `postToolUse.parameters` — probing only the PreToolUse key left every captured
// answer without its question (`question: ""` on 24/24 real rows), and history
// pairs are matched by question text, so no real pair could ever assemble.
function readInput(event) {
  const raw = event?.tool_call?.input;
  const params = {
    ...decodeParams(event?.preToolUse?.parameters),
    ...decodeParams(event?.postToolUse?.parameters),
  };
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

// Which conversation does this hook call belong to? Every hook call is a FRESH
// process and Cline is not guaranteed to send the same id fields to PreToolUse
// and PostToolUse — so we resolve BOTH candidates per call:
//   session: an explicit id from the event (stable across restarts/shell wrappers)
//   proc:    the parent process id = the Cline session that spawned us
//             (always consistent between the two hooks of one session)
// Rows store both, and a session-scoped read matches EITHER, so pairing survives
// a payload that carries an id to one hook and not the other.
function sessionInfo(event) {
  const e = event || {};
  const candidates = [
    e.sessionId, e.session_id, e.session, e.taskId, e.task_id, e.conversationId, e.conversation_id,
    e.agent_id, e.agentId, e.agent?.id,
    e.preToolUse?.sessionId, e.postToolUse?.sessionId,
    e.tool_call?.sessionId, e.tool_call?.taskId,
  ];
  let session = null;
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      session = c.trim().slice(0, 64);
      break;
    }
  }
  return { session, proc: `ppid:${process.ppid}` };
}

const workspaceRoot = (event) => {
  const roots = Array.isArray(event?.workspaceRoots) ? event.workspaceRoots : [];
  const root = event?.workspaceInfo?.rootPath || roots[0] || "";
  return typeof root === "string" && root ? root : null;
};

/* ---------- SQLite store (decision history) ---------- */

// `false` caches "no SQLite on this runtime" so we probe only once per process.
let dbCache = null;

function sqlitePath(cfg) {
  const os = __req("node:os");
  const dir = cfg.logDir || `${os.homedir()}/.cline/data/logs`;
  return cfg.dbPath || `${dir}/jev-hook.db`;
}

// One-time import of the pre-SQLite JSONL trail, so history recorded before the
// upgrade survives. Imported rows carry session/workspace NULL (= legacy) and
// stay visible to every scope. Runs inside an IMMEDIATE transaction so two
// hook processes racing on a fresh store don't each import the same trail.
function backfill(d, jsonlPath) {
  const fs = __req("node:fs");
  try {
    d.exec("BEGIN IMMEDIATE");
    let done = false;
    try {
      if (d.prepare("SELECT COUNT(*) AS n FROM events").get().n > 0) {
        done = true;
      } else {
        const raw = fs.readFileSync(jsonlPath, "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (!e?.event) continue;
            // shared column mapping with live writes — a separate INSERT here
            // once silently dropped the `state` column on imported rows
            insertEvent(d, e);
          } catch {}
        }
      }
    } finally {
      d.exec(done ? "ROLLBACK" : "COMMIT");
    }
  } catch {
    /* no trail to import, or lost the creation race: the other process imported it */
  }
}

// Open (and migrate) the store. Returns false when node:sqlite is unavailable
// (Node < 22.5, or Node 22.x without --experimental-sqlite): scoring still
// works, it just runs without decision history.
function openDb(cfg) {
  if (dbCache !== null) return dbCache;
  try {
    const { DatabaseSync } = __req("node:sqlite");
    const fs = __req("node:fs");
    const path = __req("node:path");
    const file = sqlitePath(cfg);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    // WAL + busy_timeout is what makes concurrent Cline sessions safe: writers
    // queue instead of failing with SQLITE_BUSY.
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA busy_timeout = 3000");
    d.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT,
        session TEXT,
        proc TEXT,
        workspace TEXT,
        event TEXT NOT NULL,
        tool TEXT,
        question TEXT,
        answer TEXT,
        options TEXT,
        state TEXT,
        source TEXT,
        reason TEXT
      )`);
    // Migration for stores created before these columns existed.
    for (const col of ["proc", "state", "source", "reason"]) {
      try {
        d.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT`);
      } catch {
        /* column already there */
      }
    }
    d.exec("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session, id)");
    d.exec("CREATE INDEX IF NOT EXISTS idx_events_proc ON events(proc, id)");
    d.exec("CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace, id)");
    const os = __req("node:os");
    backfill(d, `${cfg.logDir || `${os.homedir()}/.cline/data/logs`}/jev-hook.jsonl`);
    dbCache = d;
    return d;
  } catch {
    dbCache = false;
    return false;
  }
}

function insertEvent(d, entry) {
  try {
    d.prepare(
      "INSERT INTO events (ts, session, proc, workspace, event, tool, question, answer, options, state, source, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      entry.ts || new Date().toISOString(),
      entry.session ?? null,
      entry.proc ?? null,
      entry.workspace ?? null,
      String(entry.event),
      entry.tool ?? null,
      entry.question ?? null,
      entry.answer ?? null,
      Array.isArray(entry.options) ? JSON.stringify(entry.options) : null,
      typeof entry.state === "string" ? entry.state : null,
      entry.source ?? null,
      entry.reason ?? null
    );
  } catch {
    /* history is best-effort; never break a question over it */
  }
}

// Scoped history: "session" (default) keeps concurrent Cline sessions
// isolated, "workspace" shares decisions across sessions in the same project,
// "global" shares everything. Legacy rows (imported from JSONL, session NULL)
// are visible to every scope.
function buildHistory(cfg, ident, workspace) {
  if (cfg.includeHistory === false) return "";
  const turns = Math.max(0, Number(cfg.historyTurns) | 0);
  if (turns === 0) return ""; // NB: `slice(-0)` would return the WHOLE array
  const d = openDb(cfg);
  if (!d) return "";
  const scope = cfg.historyScope || "session";
  let sql = "SELECT event, question, answer FROM events WHERE event IN ('intercept','answer')";
  const params = [];
  if (scope === "session") {
    // Isolation + pairing in one rule: an explicit id matches only the same id;
    // id-less rows pair through the parent process (a hook payload that carries
    // an id to PreToolUse but not PostToolUse still pairs); rows imported from
    // the pre-SQLite JSONL trail (no id, no proc) stay visible to everyone.
    sql += " AND ((session IS NOT NULL AND session = ?) OR (session IS NULL AND proc = ?) OR (session IS NULL AND proc IS NULL))";
    params.push(ident?.session ?? null, ident?.proc ?? null);
  } else if (scope === "workspace") {
    sql += " AND (workspace = ? OR workspace IS NULL)";
    params.push(workspace ?? null);
  }
  sql += " ORDER BY id DESC LIMIT 200";
  let rows;
  try {
    rows = d.prepare(sql).all(...params);
  } catch {
    return "";
  }
  // Oldest -> newest, then pair each `intercept` with the next `answer` for the
  // same question (both already scoped to this session/workspace).
  const pairs = [];
  let lastQ = null;
  for (const e of rows.reverse()) {
    if (e.event === "intercept" && typeof e.question === "string") {
      lastQ = e;
    } else if (e.event === "answer" && typeof e.question === "string" && e.answer && lastQ?.question === e.question) {
      pairs.push([lastQ.question, e.answer]);
      lastQ = null;
    }
  }
  let budget = Math.max(0, (cfg.maxStateChars ?? 2000) - 400); // keep room for question + workspace
  const lines = [];
  for (const [q, a] of pairs.slice(-turns).reverse()) {
    const line = `Q: ${trunc(q, 160)} → chose: ${trunc(a, 80)}`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length + 1;
  }
  return lines.length ? `\nRecent decisions in this session:\n${lines.join("\n")}` : "";
}

// The full `state` payload: question + workspace + (optional) decision history.
function buildState(event, question) {
  const cfg = resolveConfig();
  let state = contextState(event, question) + buildHistory(cfg, sessionInfo(event), workspaceRoot(event));
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
      // Test callers may inject logDir/cfg via deps: merge, don't replace, so the
      // JSONL and SQLite sinks always resolve the SAME directory.
      const cfg = { ...resolveConfig(), ...(deps?.cfg || {}), ...(deps?.logDir ? { logDir: deps.logDir } : {}) };
      const dir = deps?.logDir || cfg.logDir || `${os.homedir()}/.cline/data/logs`;
      // A fresh logDir does not exist yet; without this every write fails
      // silently and the decision history would never populate.
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
      logSink = { fs, cfg, path: `${dir}/jev-hook.jsonl` };
    }
    const record = { ts: new Date().toISOString(), ...entry };
    // 1) SQLite FIRST: the one-time backfill must not see this row, or it
    //    would import it and then insertEvent would store it a second time.
    const d = openDb(logSink.cfg);
    if (d) insertEvent(d, record);
    // 2) JSONL: the human-readable audit trail (`tail` it to debug).
    logSink.fs.appendFileSync(logSink.path, JSON.stringify(record) + "\n");
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
  // Session identity + workspace travel with every row so history can be
  // scoped later (concurrent Cline sessions must not see each other's answers).
  const ctx = { ...sessionInfo(event), workspace: workspaceRoot(event) };
  const input = readInput(event);
  const question = input.question;
  const options = input.options;
  if (typeof question !== "string" || !Array.isArray(options) || !options.every((o) => typeof o === "string")) {
    console.log(JSON.stringify({})); // unexpected shape: allow as-is
    return;
  }
  if (options.length < 2) {
    await log({ event: "skip", reason: "single_option", ...ctx, source: "hook", question });
    console.log(JSON.stringify({})); // nothing to score
    return;
  }
  if (options.some(hasPct)) {
    // The question is kept so the trail shows WHAT was bypassed (usually a
    // question the model pre-scored through the MCP tool).
    await log({ event: "skip", reason: "already_enriched", ...ctx, source: "hook", question });
    console.log(JSON.stringify({})); // idempotent: never double-tag
    return;
  }
  await log({ event: "intercept", ...ctx, tool: toolName, source: "hook", question, options });
  try {
    const state = buildState(event, question);
    const probs = await score(state, question, options);
    const enriched = options.map((o) => withPct(o, probs[o]));
    // `state` is recorded verbatim: the audit trail shows exactly what Jev received.
    await log({ event: "enriched", ...ctx, source: "hook", question, state, enriched });
    console.log(JSON.stringify({ cancel: false, overrideInput: { ...input, question, options: enriched } }));
  } catch (e) {
    console.error(`[jev-percent] scoring failed, allowing as-is: ${e?.message || e}`);
    await log({ event: "fail_open", ...ctx, source: "hook", error: String(e?.message || e) });
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

// Shape of a hook payload, recorded when we could not extract what we needed.
// Keys and value KINDS only — never the contents — so a shape change in Cline is
// diagnosable from the audit trail without leaking question/answer text.
function shapeOf(event) {
  const kind = (v) => (v == null ? "absent" : Array.isArray(v) ? "array" : typeof v);
  return {
    eventKeys: Object.keys(event || {}),
    toolCallKeys: Object.keys(event?.tool_call || {}),
    preToolUseKeys: Object.keys(event?.preToolUse || {}),
    postToolUseKeys: Object.keys(event?.postToolUse || {}),
    paramsKind: {
      pre: kind(event?.preToolUse?.parameters),
      post: kind(event?.postToolUse?.parameters),
      input: kind(event?.tool_call?.input),
    },
  };
}

// Cline reports these instead of a choice: the user closed the question (and
// then often types the answer as chat text, which NO hook can see), or the tool
// call failed schema validation (e.g. more than 5 options). They are not
// decisions — recording them would put `chose: [User dismissed the question]`
// into the next question's context.
function nonAnswerReason(answer) {
  const t = String(answer).trim();
  if (/^\[User dismissed the question\]$/i.test(t)) return "dismissed";
  if (/^✖/.test(t) || /^\{"?error"?\s*:/.test(t) || /^Error:/i.test(t)) return "tool_error";
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
  const ctx = { ...sessionInfo(event), workspace: workspaceRoot(event) };
  const dismissal = answer ? nonAnswerReason(answer) : null;
  if (answer && dismissal) {
    // Kept in the audit trail for visibility, but never as a decision: an
    // unpaired/typed answer must not become the next question's context.
    await log({ event: "answer_dismissed", ...ctx, source: "hook", tool: toolName, question, answer, reason: dismissal });
  } else if (answer && question) {
    await log({ event: "answer", ...ctx, source: "hook", tool: toolName, question, answer });
  } else if (answer) {
    // The answer was captured but its question was not. History pairs are
    // matched by question text, so this row would never pair — record the
    // payload shape that tells us where the question actually lives.
    await log({ event: "question_unclear", ...ctx, source: "hook", tool: toolName, answer, ...shapeOf(event) });
  } else {
    // Self-debugging: if the shape ever changes, the trail tells us where to look.
    await log({ event: "answer_unclear", ...ctx, source: "hook", tool: toolName, question, ...shapeOf(event) });
  }
  console.log(JSON.stringify({}));
}

export { main, postMain, log };

