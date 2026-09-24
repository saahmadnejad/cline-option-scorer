// Regression tests for hooks/PreToolUse.cjs, run against a local Jev stub.
//
// The bug these lock down: Cline's hook runtime flattens
// `preToolUse.parameters` by JSON.stringify()-ing every non-string value, so
// `options` arrives as the STRING '["A","B"]'. A guard of
// Array.isArray(options) therefore silently no-oped on every real payload.
//
// Configuration is JSON-only: the hook reads cline-jev.json (project root
// first) and NO environment variables. Each test spawns the hook with cwd set
// to a throwaway project dir whose cline-jev.json points at the stub, so any
// real ~/.cline/cline-jev.json can never leak into these runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO, "hooks", "PreToolUse.cjs");
// The hook is a thin entrypoint that requires the generated jev-hook-lib.js
// beside it. Build it exactly like an install would — targeted at the repo,
// never at ~/.cline.
execFileSync(process.execPath, [join(REPO, "scripts", "install-hook.mjs"), "--dir", join(REPO, "hooks")], {
  stdio: "pipe",
});

// Every hook run writes its audit log here (via `logDir` in the test config).
const LOG_DIR = mkdtempSync(join(tmpdir(), "jev-hook-test-"));

// Decision history needs node:sqlite (Node >= 22.5; unflagged from 23.4), so
// probe the runtime instead of guessing from the version string.
const hasSqlite = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();
const sqliteSkip = hasSqlite ? false : "node:sqlite unavailable on this Node (needs >= 22.5, unflagged from 23.4)";

// Local stand-in for https://opencode.ai/zen/v1/systemone
async function startStub(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(JSON.parse(body || "{}"), res));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const calls = [];
  const base = {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
  // count every request so tests can assert the hook never called Jev
  const original = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    calls.push(req.url);
    original(req, res);
  });
  return base;
}

// Echo back a probability per criterion SLUG, exactly like real Jev does:
// `answers.pick.probabilities` is keyed by the criterion keys (slugs), not by
// the label text - which is why the hook looks up `probabilities[slug(option)]`.
function jevAnswer(probabilities) {
  return (body) => {
    const criteria = body?.questions?.pick?.criteria ?? {};
    const mapped = {};
    for (const [slug, label] of Object.entries(criteria)) mapped[slug] = probabilities[label] ?? 0;
    const firstSlug = Object.keys(criteria)[0];
    return { model: "stub-jev", answers: { pick: { choice: firstSlug, probabilities: mapped, confidence: 0.9 } } };
  };
}

// Runs the hook exactly like Cline does: `node <file>`, payload on stdin.
// Config is JSON-only: each run gets a throwaway project dir (package.json
// marks it as a project root) whose cline-jev.json points scoring at the stub
// and the audit log at LOG_DIR.
function makeProjectDir(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "jev-proj-"));
  writeFileSync(join(dir, "package.json"), '{ "name": "jev-hook-test-project" }');
  writeFileSync(join(dir, "cline-jev.json"), JSON.stringify({ logDir: LOG_DIR, ...cfg }));
  return dir;
}

function runHook(payload, cfg = {}) {
  const dir = makeProjectDir(cfg);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out: out.trim(), err }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

// Cline flattened `preToolUse.parameters` with JSON.stringify() on non-strings.
const flatten = (input) =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));

// A payload shaped exactly like the one the hook runtime writes to hooks.jsonl
// (see @cline/core: beforeTool -> { tool_call: { id, name, input }, preToolUse:
// { toolName, parameters: flatten(input) } }).
function realPayload(input, toolName = "ask_question") {
  return {
    hookName: "tool_call",
    timestamp: new Date().toISOString(),
    workspaceRoots: ["/home/ali/Projects/cline-option-scorer"],
    userId: "ali",
    agent_id: "agent_test",
    parent_agent_id: null,
    iteration: 3,
    tool_call: { id: "call-1", name: toolName, input },
    preToolUse: { toolName, parameters: flatten(input) },
  };
}

const parse = (out) => JSON.parse(out || "{}");

test("scores a real Cline payload whose `options` arrived flattened as a JSON string", async () => {
  const stub = await startStub((body, res) => {
    res.end(JSON.stringify(jevAnswer({ "GitHub Actions": 0.72, "GitLab CI": 0.25, Jenkins: 0.03 })(body)));
  });
  try {
    const input = { question: "Which CI/CD platform?", options: ["GitHub Actions", "GitLab CI", "Jenkins"] };
    const { code, out } = await runHook(realPayload(input), { baseUrl: stub.url });
    const result = parse(out);

    assert.equal(code, 0);
    assert.equal(result.cancel, false);
    // the regression: this used to be {} because Array.isArray("[...]") is false
    assert.deepEqual(result.overrideInput.options, [
      "GitHub Actions (72.0%)",
      "GitLab CI (25.0%)",
      "Jenkins (3.0%)",
    ]);
    assert.equal(result.overrideInput.question, input.question);
    assert.equal(stub.calls.length, 1, "exactly one Jev call");
  } finally {
    await stub.close();
  }
});

test("uses `tool_call.input` (unflattened) plus workspace context when both are present", async () => {
  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 0.6, B: 0.4 })(body)));
  });
  try {
    const { out } = await runHook(realPayload({ question: "Pick one", options: ["A", "B"] }), { baseUrl: stub.url });
    assert.deepEqual(parse(out).overrideInput.options, ["A (60.0%)", "B (40.0%)"]);
    assert.match(seen.state, /^Pick one\n\(workspace: \/home\/ali\/Projects\/cline-option-scorer\)$/);
    assert.equal(seen.model, "jev-1.13-free");
  } finally {
    await stub.close();
  }
});

test("decodes flattened parameters even when `tool_call.input` is absent", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ Alpha: 1, Beta: 0 })(body))));
  try {
    const input = { question: "A or B?", options: ["Alpha", "Beta"] };
    const payload = {
      hookName: "tool_call",
      workspaceRoots: ["/tmp"],
      preToolUse: { toolName: "ask_followup_question", parameters: flatten(input) },
    };
    const { out } = await runHook(payload, { baseUrl: stub.url });
    assert.deepEqual(parse(out).overrideInput.options, ["Alpha (100.0%)", "Beta (0.0%)"]);
  } finally {
    await stub.close();
  }
});




test("passes through untouched for non-question tools (and never calls Jev)", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({})(body))));
  try {
    const { code, out } = await runHook(realPayload({ command: "ls -la" }, "execute_command"), { baseUrl: stub.url });
    assert.equal(code, 0);
    assert.deepEqual(parse(out), {});
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("is idempotent: options that already carry a percentage are never double-tagged", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({})(body))));
  try {
    const input = { question: "Pick", options: ["A (10.0%)", "B"] };
    const { out } = await runHook(realPayload(input), { baseUrl: stub.url });
    assert.deepEqual(parse(out), {});
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("passes through a single-option question (nothing to rank)", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({})(body))));
  try {
    const { out } = await runHook(realPayload({ question: "Continue?", options: ["Yes"] }), { baseUrl: stub.url });
    assert.deepEqual(parse(out), {});
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("passes through unparsable stdin without crashing", async () => {
  const { code, out } = await runHook("not json at all");
  assert.equal(code, 0);
  assert.deepEqual(parse(out), {});
});


test("fails open (allows the question as-is) when Jev returns an error status", async () => {
  const stub = await startStub((body, res) => {
    res.statusCode = 503;
    res.end("upstream unavailable");
  });
  try {
    const input = { question: "Pick", options: ["A", "B"] };
    const { code, out, err } = await runHook(realPayload(input), { baseUrl: stub.url });
    assert.equal(code, 0);
    assert.deepEqual(parse(out), {});
    assert.match(err, /scoring failed/);
  } finally {
    await stub.close();
  }
});

test("fails open when Jev hangs past the configured timeoutMs", async () => {
  const stub = await startStub(() => {
    /* never responds: the hook must abort, not hang Cline */
  });
  try {
    const input = { question: "Pick", options: ["A", "B"] };
    const started = Date.now();
    const { code, out } = await runHook(realPayload(input), { baseUrl: stub.url, timeoutMs: 150 });
    assert.equal(code, 0);
    assert.deepEqual(parse(out), {});
    assert.ok(Date.now() - started < 10000, "gave up well before the default 10s timeout");
  } finally {
    await stub.close();
  }
});

test("unknown option slugs score 0.0% instead of NaN", async () => {
  const stub = await startStub((_body, res) =>
    res.end(
      JSON.stringify({
        model: "stub-jev",
        answers: { pick: { choice: "only_known", probabilities: { only_known: 1 }, confidence: 0.5 } },
      })
    )
  );
  try {
    const { out } = await runHook(realPayload({ question: "Pick", options: ["Known", "Missing"] }), {
      baseUrl: stub.url,
    });
    assert.deepEqual(parse(out).overrideInput.options, ["Known (0.0%)", "Missing (0.0%)"]);
    assert.ok(!out.includes("NaN"));
  } finally {
    await stub.close();
  }
});

test("writes an audit trail to the configured logDir", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ A: 0.9, B: 0.1 })(body))));
  try {
    await runHook(realPayload({ question: "Log me", options: ["A", "B"] }), { baseUrl: stub.url });
    const lines = readFileSync(join(LOG_DIR, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.filter((l) => l.question === "Log me").map((l) => l.event);
    assert.deepEqual(events, ["intercept", "enriched"]);
    const row = lines.find((l) => l.event === "enriched" && l.question === "Log me");
    assert.ok(typeof row.state === "string", "enriched row records the state");
    assert.match(row.state, /Log me/); // at minimum the question itself is visible
  } finally {
    await stub.close();
  }
});

test("creates the audit log directory when it does not exist yet", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body))));
  const freshDir = join(LOG_DIR, `fresh-${Date.now()}`, "logs"); // does not exist yet
  try {
    await runHook(realPayload({ question: "Fresh log dir?", options: ["A", "B"] }), {
      baseUrl: stub.url,
      logDir: freshDir,
    });
    const lines = readFileSync(join(freshDir, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.event === "intercept" && l.question === "Fresh log dir?"));
  } finally {
    await stub.close();
  }
});

// ---------- PostToolUse: answer capture → history-enriched state ----------

// Runs the PostToolUse hook exactly like Cline does.
function runPostHook(payload, cfg = {}) {
  const dir = makeProjectDir(cfg);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, "hooks", "PostToolUse.cjs")], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

const postPayload = (input, response) => ({
  hookName: "tool_call",
  tool_call: { id: "call-2", name: "ask_question", input, response },
  postToolUse: { toolName: "ask_question", response },
});

test("PostToolUse captures the chosen answer and the next question's state includes it", { skip: sqliteSkip }, async () => {
  // 0) the question is actually asked first (PreToolUse logs the intercept)
  let stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ Postgres: 0.7, SQLite: 0.3 })(body))));
  try {
    await runHook(realPayload({ question: "Pick a DB", options: ["Postgres", "SQLite"] }), { baseUrl: stub.url });
  } finally {
    await stub.close();
  }

  // 1) the post hook records the decision
  const post = await runPostHook(
    postPayload({ question: "Pick a DB", options: ["Postgres", "SQLite"] }, { answer: "Postgres" })
  );
  assert.equal(post.code, 0);
  assert.deepEqual(JSON.parse(post.out || "{}"), {});
  const lines = readFileSync(join(LOG_DIR, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === "answer" && l.question === "Pick a DB" && l.answer === "Postgres"));

  // 2) the next question scores with that decision in its state
  let seen = null;
  stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 0.6, B: 0.4 })(body)));
  });
  try {
    await runHook(realPayload({ question: "Pick a framework", options: ["A", "B"] }), { baseUrl: stub.url });
    assert.match(seen.state, /Recent decisions in this session:/);
    assert.match(seen.state, /Q: Pick a DB → chose: Postgres/);
    // the audit trail stores the state verbatim — what you read is what Jev got
    const trail = readFileSync(join(LOG_DIR, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const logged = trail.filter((l) => l.event === "enriched" && l.question === "Pick a framework").pop();
    assert.equal(logged.state, seen.state, "trail state === request state");
  } finally {
    await stub.close();
  }
});

test("PostToolUse is observe-only: unknown payload shapes log answer_unclear, never crash", async () => {
  const post = await runPostHook(postPayload({ question: "Odd shape", options: ["A", "B"] }, { weird: { nested: [1, 2] } }));
  assert.equal(post.code, 0);
  assert.deepEqual(JSON.parse(post.out || "{}"), {});
  const lines = readFileSync(join(LOG_DIR, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const entry = lines.find((l) => l.event === "answer_unclear" && l.question === "Odd shape");
  assert.ok(entry, "answer_unclear entry written");
  assert.ok(Array.isArray(entry.toolCallKeys), "key names recorded for debugging");
});

test("history knobs: includeHistory false and historyTurns 0 both keep state clean", { skip: sqliteSkip }, async () => {
  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body)));
  });
  try {
    await runHook(realPayload({ question: "No history please", options: ["A", "B"] }), {
      baseUrl: stub.url,
      includeHistory: false,
    });
    assert.ok(!seen.state.includes("Recent decisions"));

    await runHook(realPayload({ question: "Zero turns", options: ["A", "B"] }), {
      baseUrl: stub.url,
      historyTurns: 0,
    });
    assert.ok(!seen.state.includes("Recent decisions"));
  } finally {
    await stub.close();
  }
});

test("maxStateChars caps the whole state payload, question included", async () => {
  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body)));
  });
  try {
    await runHook(realPayload({ question: "x".repeat(3000), options: ["A", "B"] }), {
      baseUrl: stub.url,
      maxStateChars: 500,
    });
    assert.ok(seen.state.length <= 500, `state was ${seen.state.length} chars, cap is 500`);
  } finally {
    await stub.close();
  }
});

// ---------- Multi-session isolation (SQLite store) ----------

const sessionPayload = (sessionId, input, toolName = "ask_question") => ({
  ...realPayload(input, toolName),
  sessionId,
});

test("concurrent sessions are isolated: one session never inherits another's decision", { skip: sqliteSkip }, async () => {
  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body)));
  });
  const cfg = { baseUrl: stub.url };
  try {
    // session 1 asks, then the user answers
    await runHook(sessionPayload("sess-1", { question: "Session 1 choice?", options: ["A", "B"] }), cfg);
    await runPostHook(
      { ...postPayload({ question: "Session 1 choice?", options: ["A", "B"] }, { answer: "A" }), sessionId: "sess-1" },
      cfg
    );

    // session 2 asks a question — must not see session 1's decision
    await runHook(sessionPayload("sess-2", { question: "Session 2 question?", options: ["A", "B"] }), cfg);
    assert.ok(!seen.state.includes("Session 1 choice?"), `session 2 inherited session 1: ${seen.state}`);

    // session 1 asks a follow-up — its own decision is present
    await runHook(sessionPayload("sess-1", { question: "Session 1 follow-up?", options: ["A", "B"] }), cfg);
    assert.match(seen.state, /Q: Session 1 choice\? → chose: A/);
  } finally {
    await stub.close();
  }
});

test("historyScope: workspace shares decisions between sessions of one project", { skip: sqliteSkip }, async () => {
  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body)));
  });
  const cfg = { baseUrl: stub.url, historyScope: "workspace" };
  try {
    await runHook(sessionPayload("ws-sess-1", { question: "Workspace choice?", options: ["A", "B"] }), cfg);
    await runPostHook(
      { ...postPayload({ question: "Workspace choice?", options: ["A", "B"] }, { answer: "B" }), sessionId: "ws-sess-1" },
      cfg
    );
    await runHook(sessionPayload("ws-sess-2", { question: "Another session's question?", options: ["A", "B"] }), cfg);
    assert.match(seen.state, /Q: Workspace choice\? → chose: B/);
  } finally {
    await stub.close();
  }
});

test("a pre-SQLite JSONL trail is imported once, so existing history survives", { skip: sqliteSkip }, async () => {
  // Seed a legacy trail in a logDir whose SQLite store does not exist yet.
  const legacyDir = join(LOG_DIR, `legacy-${Date.now()}`, "logs");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "jev-hook.jsonl"),
    [
      JSON.stringify({ ts: new Date().toISOString(), event: "intercept", question: "Legacy question?", options: ["A", "B"] }),
      JSON.stringify({ ts: new Date().toISOString(), event: "enriched", question: "Legacy scored?", state: "Legacy scored? (ctx)", enriched: ["A (60.0%)", "B (40.0%)"] }),
      JSON.stringify({ ts: new Date().toISOString(), event: "answer", question: "Legacy question?", answer: "B" }),
    ].join("\n") + "\n"
  );

  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body)));
  });
  try {
    await runHook(realPayload({ question: "After the upgrade?", options: ["A", "B"] }), {
      baseUrl: stub.url,
      logDir: legacyDir,
    });
    assert.match(seen.state, /Q: Legacy question\? → chose: B/);
    // the imported enriched row must keep its state column (backfill shares
    // the same column mapping as live writes)
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const d = new DatabaseSync(join(legacyDir, "jev-hook.db"));
    const row = d.prepare("SELECT state FROM events WHERE event = 'enriched' AND question = 'Legacy scored?'").get();
    assert.ok(row, "the enriched row from the JSONL trail was imported");
    assert.match(row.state, /Legacy scored\?/);
    d.close();
  } finally {
    await stub.close();
  }
});

test("the backfill never duplicates the row the first writer appends", { skip: sqliteSkip }, async () => {
  // On a brand-new store the first logged row must end up exactly once: it is
  // written to SQLite before the JSONL append, so the one-time import cannot
  // re-import it afterwards.
  const dir = join(LOG_DIR, `dedup-${Date.now()}`, "logs");
  mkdirSync(dir, { recursive: true });
  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body)));
  });
  try {
    await runHook(realPayload({ question: "First row?", options: ["A", "B"] }), {
      baseUrl: stub.url,
      logDir: dir,
    });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const d = new DatabaseSync(join(dir, "jev-hook.db"));
    const n = d.prepare("SELECT COUNT(*) AS n FROM events WHERE event = 'intercept' AND question = ?").get("First row?").n;
    assert.equal(n, 1, "the first intercept is stored exactly once");
    d.close();
  } finally {
    await stub.close();
  }
});

// ---------- PostToolUse: the real payload carries the input in postToolUse.parameters ----------

function trailRows() {
  return readFileSync(join(LOG_DIR, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("captures the question when PostToolUse delivers it via postToolUse.parameters", async () => {
  // Production shape: `tool_call.input` is absent and the answer lives in the
  // tool result, so the question must come from the decoded postToolUse
  // parameters. Without this every captured answer had question:"" and could
  // never pair into history.
  const stamp = Date.now();
  const question = `Production shape ${stamp}?`;
  const answer = `Chosen answer ${stamp}`;
  await runPostHook({
    hookName: "tool_call",
    tool_call: { id: "call-prod", name: "ask_followup_question", output: answer },
    postToolUse: { toolName: "ask_followup_question", parameters: flatten({ question, options: ["x", "y"] }) },
  });
  const row = trailRows().find((l) => l.answer === answer);
  assert.ok(row, "the answer was captured");
  assert.equal(row.event, "answer");
  assert.equal(row.question, question, "question recovered from postToolUse.parameters");
});

test("logs question_unclear (with the payload shape) when an answer arrives without its question", async () => {
  const stamp = Date.now();
  const answer = `Orphan answer ${stamp}`;
  await runPostHook({
    hookName: "tool_call",
    tool_call: { name: "ask_followup_question", output: answer },
    postToolUse: { toolName: "ask_followup_question" },
  });
  const row = trailRows().find((l) => l.event === "question_unclear" && l.answer === answer);
  assert.ok(row, "question_unclear row written instead of an unpaired answer row");
  assert.deepEqual(row.paramsKind, { pre: "absent", post: "absent", input: "absent" });
  assert.ok(Array.isArray(row.toolCallKeys) && Array.isArray(row.postToolUseKeys));
});

test("skip rows carry the session so skips stay attributable", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({})(body))));
  const question = `Already scored ${Date.now()}?`;
  try {
    await runHook(sessionPayload("skip-sess-1", { question, options: ["A (10.0%)", "B (90.0%)"] }), { baseUrl: stub.url });
    const row = trailRows().find((l) => l.event === "skip" && l.reason === "already_enriched" && l.session === "skip-sess-1");
    assert.ok(row, "the skip row records the session id");
    assert.equal(row.question, question, "and the question it skipped");
    assert.equal(row.source, "hook");
  } finally {
    await stub.close();
  }
});

// ---------- MCP path: pre-scored questions must reach the same trail ----------

function runMcp(frames, cfg = {}) {
  const dir = makeProjectDir(cfg);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, "mcp-server.js")], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out }));
  });
}

const mcpCall = (id, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "score_cline_options", arguments: args },
});

test("MCP-scored questions are logged (source mcp) instead of vanishing from the trail", async () => {
  const dir = join(LOG_DIR, `mcp-log-${Date.now()}`, "logs");
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ A: 0.8, B: 0.2 })(body))));
  const question = `MCP trail ${Date.now()}?`;
  try {
    const { code, out } = await runMcp([mcpCall(1, { state: "mcp-context", question, options: ["A", "B"] })], {
      baseUrl: stub.url,
      logDir: dir,
    });
    assert.equal(code, 0);
    assert.match(out, /enrichedOptions/);
    const rows = readFileSync(join(dir, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => [r.event, r.source]),
      [["intercept", "mcp"], ["enriched", "mcp"]]
    );
    assert.equal(rows[1].state, "mcp-context", "the state sent to Jev is recorded");
    assert.match(rows[1].enriched.join(" "), /A \(80\.0%\)/);
    if (hasSqlite) {
      // The README documents querying the store by source, so the column must
      // exist there too — not just in the JSONL trail.
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const d = new DatabaseSync(join(dir, "jev-hook.db"));
      const bySource = d.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'mcp'").get().n;
      const stateRow = d.prepare("SELECT state FROM events WHERE source = 'mcp' AND event = 'enriched'").get();
      d.close();
      assert.equal(bySource, 2, "both MCP rows are queryable by source");
      assert.equal(stateRow.state, "mcp-context");
    }
  } finally {
    await stub.close();
  }
});

test("a question scored through MCP becomes history for the next hook-scored question", { skip: sqliteSkip }, async () => {
  // The user-facing loop this locks down: the model pre-scores via the MCP tool,
  // the user answers, and the NEXT question must carry that pair as context —
  // even though no hook ever scored the first question.
  const dir = join(LOG_DIR, `mcp-history-${Date.now()}`, "logs");
  const stamp = Date.now();
  const mcpQuestion = `MCP history source ${stamp}?`;
  const answer = `Postgres ${stamp}`;
  const nextQuestion = `Follow up after MCP ${stamp}?`;
  let seen = null;
  const stub = await startStub((body, res) => {
    seen = body;
    res.end(JSON.stringify(jevAnswer({ A: 1, B: 0 })(body)));
  });
  try {
    await runMcp([mcpCall(1, { state: "ctx", question: mcpQuestion, options: [answer, "MySQL"] })], {
      baseUrl: stub.url,
      logDir: dir,
    });
    await runPostHook(postPayload({ question: mcpQuestion, options: [answer, "MySQL"] }, answer), {
      baseUrl: stub.url,
      logDir: dir,
    });
    await runHook(realPayload({ question: nextQuestion, options: ["A", "B"] }), { baseUrl: stub.url, logDir: dir });
    assert.match(seen.state, /Recent decisions in this session:/, "history block present");
    assert.match(seen.state, new RegExp(`Q: .*MCP history source ${stamp}`), "the MCP-scored question is in context");
    assert.match(seen.state, new RegExp(`chose: ${answer}`), "with the answer the user chose");
  } finally {
    await stub.close();
  }
});

// ---------- answers that are not choices (dismissed questions, tool errors) ----------

test("a dismissed question is recorded, but never as a decision", async () => {
  // Cline reports "[User dismissed the question]" when the user closes the
  // question and answers in chat instead. That text is not a choice: recording
  // it would put `chose: [User dismissed the question]` into history.
  const stamp = Date.now();
  const question = `Dismissed question ${stamp}?`;
  await runPostHook(postPayload({ question, options: ["A", "B"] }, "[User dismissed the question]"));
  const rows = trailRows();
  const dismissed = rows.find((l) => l.event === "answer_dismissed" && l.question === question);
  assert.ok(dismissed, "logged as answer_dismissed with the question kept");
  assert.equal(dismissed.reason, "dismissed");
  assert.ok(!rows.some((l) => l.event === "answer" && String(l.answer).includes("dismissed")), "never logged as a real answer");
  if (hasSqlite) {
    // The dismissal must be queryable in the store, not only in the JSONL.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const d = new DatabaseSync(join(LOG_DIR, "jev-hook.db"));
    const row = d.prepare("SELECT reason FROM events WHERE event = 'answer_dismissed' AND question = ?").get(question);
    d.close();
    assert.equal(row?.reason, "dismissed", "reason column records why it was not a decision");
  }
});

test("a tool-schema failure is not recorded as a decision either", async () => {
  const stamp = Date.now();
  const question = `Invalid question ${stamp}?`;
  await runPostHook(postPayload({ question, options: ["A", "B"] }, '{"error":"✖ Too big: expected array to have <=5 items   → at options"}'));
  const row = trailRows().find((l) => l.event === "answer_dismissed" && l.question === question);
  assert.ok(row, "logged as answer_dismissed");
  assert.equal(row.reason, "tool_error");
});

test("the MCP tool refuses more than 5 options (Cline's limit) with an actionable message", async () => {
  const dir = join(LOG_DIR, `mcp-limit-${Date.now()}`, "logs");
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({})(body))));
  const question = `Too many options ${Date.now()}?`;
  try {
    const { code, out } = await runMcp(
      [mcpCall(1, { question, options: ["A", "B", "C", "D", "E", "F"] })],
      { baseUrl: stub.url, logDir: dir }
    );
    assert.equal(code, 0);
    assert.match(out, /at most 5/);
    assert.match(out, /"isError":true/);
    assert.equal(stub.calls.length, 0, "no Jev call for a question Cline would reject");
    assert.ok(!existsSync(join(dir, "jev-hook.jsonl")), "nothing logged for an invalid question");
  } finally {
    await stub.close();
  }
});

test("the installer also drops the prompt-steering skill and rules into a real .cline home", async () => {
  // Without these files no session ever reads the 2-5 option rule, so the model
  // keeps composing questions the hooks can't help with.
  const fakeHome = mkdtempSync(join(tmpdir(), "jev-fakehome-"));
  execFileSync(process.execPath, [join(REPO, "scripts", "install-hook.mjs")], {
    env: { ...process.env, HOME: fakeHome },
    stdio: "pipe",
  });
  const skill = join(fakeHome, ".cline", "skills", "jev-percentages", "SKILL.md");
  const rules = join(fakeHome, ".cline", "rules", "cline-option-scorer.md");
  assert.ok(existsSync(skill), "skill installed into the given home");
  assert.ok(existsSync(rules), "rules installed into the given home");
  assert.match(readFileSync(skill, "utf8"), /2-5/, "skill states the option cap");
  assert.match(readFileSync(skill, "utf8"), /dismiss/i, "skill explains typed/dismissed answers");
  assert.match(readFileSync(rules, "utf8"), /2-5/, "rules state the option cap");
  // The hooks themselves must still land there too.
  assert.ok(existsSync(join(fakeHome, ".cline", "hooks", "PreToolUse.cjs")));
});

test("MCP autoAnswer: the directive names the winner and the audit row records it", async () => {
  // Default off everywhere: without the flag the same call must NOT ask to skip.
  const dir = join(LOG_DIR, `mcp-auto-${Date.now()}`, "logs");
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ A: 0.8, B: 0.2 })(body))));
  const question = `MCP auto-answer ${Date.now()}?`;
  try {
    const { code, out } = await runMcp(
      [mcpCall(1, { question, options: ["A", "B"], autoAnswer: true })],
      { baseUrl: stub.url, logDir: dir }
    );
    assert.equal(code, 0);
    assert.match(out, /DO NOT ask the user this question/, "a skip-asking directive, not just scores");
    assert.match(out, /Auto-answered \(autoAnswer enabled\): A \(80\.0%\) — question: /, "which option, with its percentage, and which question");
    assert.match(out, /Treat 'A' as the user's answer/, "the exact label the model must act on");
    const rows = readFileSync(join(dir, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const enriched = rows.find((r) => r.event === "enriched" && r.source === "mcp");
    assert.ok(enriched, "decision recorded on the enriched row");
    assert.equal(enriched.reason, "auto_answer: A", "the audit row says what was decided");
  } finally {
    await stub.close();
  }
});

test("MCP without autoAnswer shows scores only, never a skip-asking directive", async () => {
  const dir = join(LOG_DIR, `mcp-manual-${Date.now()}`, "logs");
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ A: 0.8, B: 0.2 })(body))));
  const question = `MCP no auto-answer ${Date.now()}?`;
  try {
    const { out } = await runMcp([mcpCall(1, { question, options: ["A", "B"] })], {
      baseUrl: stub.url,
      logDir: dir,
    });
    assert.match(out, /enrichedOptions/);
    assert.ok(!out.includes("DO NOT ask"), "default off: scores only, user still decides");
    const rows = readFileSync(join(dir, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const enriched = rows.find((r) => r.event === "enriched");
    assert.ok(enriched && enriched.reason == null, "no auto_answer reason recorded");
  } finally {
    await stub.close();
  }
});

test("MCP file-level autoAnswer:true applies without a per-call flag", async () => {
  const dir = join(LOG_DIR, `mcp-auto-file-${Date.now()}`, "logs");
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ A: 0.8, B: 0.2 })(body))));
  const question = `MCP file auto-answer ${Date.now()}?`;
  try {
    const { out } = await runMcp([mcpCall(1, { question, options: ["A", "B"] })], {
      baseUrl: stub.url,
      logDir: dir,
      autoAnswer: true, // lands in cline-jev.json of the throwaway project dir
    });
    assert.match(out, /DO NOT ask the user this question/, "file flag alone enables it");
  } finally {
    await stub.close();
  }
});

