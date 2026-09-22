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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
  } finally {
    await stub.close();
  }
});
