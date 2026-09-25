// Regression tests for hooks/PreToolUse.cjs and PostToolUse.cjs, run against a local Jev stub.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO, "hooks", "PreToolUse.cjs");
const POST_HOOK = join(REPO, "hooks", "PostToolUse.cjs");

// The hook is a thin entrypoint that requires the generated jev-hook-lib.cjs beside it.
execFileSync(process.execPath, [join(REPO, "scripts", "install-hook.mjs"), "--dir", join(REPO, "hooks")], {
  stdio: "pipe",
});

const LOG_DIR = mkdtempSync(join(tmpdir(), "jev-hook-test-"));

const hasSqlite = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();
const sqliteSkip = hasSqlite ? false : "node:sqlite unavailable on this runtime (needs Node >= 22.5)";

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
  const original = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    calls.push(req.url);
    original(req, res);
  });
  return base;
}

// Mirrors the real API contract: response probabilities/choice are keyed by
// the criterion IDs from the request's `criteria` map (e.g. `opt_0`), so the
// stub echoes per-ID probabilities derived from the original labels.
function jevAnswer(probabilities) {
  return (body) => {
    const criteria = body?.questions?.pick?.criteria ?? {};
    const entries = Object.entries(criteria); // [id, label]
    const sum = entries.reduce((acc, [, label]) => acc + (probabilities[label] ?? 0), 0) || 1;
    const mapped = {};
    for (const [id, label] of entries) mapped[id] = (probabilities[label] ?? 0) / sum;
    const top = entries.slice().sort((a, b) => mapped[b[0]] - mapped[a[0]])[0];
    return {
      model: "jev-1.13-free",
      answers: {
        pick: {
          choice: top?.[0] ?? "none",
          confidence: top ? mapped[top[0]] : 0,
          probabilities: mapped,
        },
      },
    };
  };
}

function makeProjectDir(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "jev-proj-"));
  writeFileSync(join(dir, "package.json"), '{ "name": "jev-hook-test-project" }');
  writeFileSync(join(dir, "cline-jev.json"), JSON.stringify({ logDir: LOG_DIR, ...cfg }));
  return dir;
}

function runHook(payload, cfg = {}) {
  const dir = makeProjectDir(cfg);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    child.stdin.end();
    child.on("close", (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out.trim());
      } catch {}
      resolve({ code, out, err, parsed });
    });
  });
}

function runPostHook(payload, cfg = {}) {
  const dir = makeProjectDir(cfg);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [POST_HOOK], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    child.stdin.end();
    child.on("close", (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out.trim());
      } catch {}
      resolve({ code, out, err, parsed });
    });
  });
}

const flatten = (input) =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));

function realPayload(input, toolName = "ask_question") {
  return {
    hookName: "tool_call",
    workspaceRoots: ["/workspace/proj"],
    workspaceInfo: { rootPath: "/workspace/proj" },
    iteration: 3,
    tool_call: { id: "call-1", name: toolName, input },
    preToolUse: { toolName, parameters: flatten(input) },
  };
}

test("scores a real Cline payload whose `options` arrived flattened as a JSON string", async () => {
  const input = {
    question: "Which DB?",
    options: ["PostgreSQL", "SQLite", "MongoDB"],
  };
  const payload = {
    hookName: "tool_call",
    workspaceRoots: ["/workspace/proj"],
    iteration: 3,
    preToolUse: {
      toolName: "ask_followup_question",
      parameters: flatten(input),
    },
  };

  const stub = await startStub((body, res) => {
    // Positional criterion IDs keep labels that slug-collide ("A & B"/"A-B")
    // apart; the response is keyed by those IDs.
    assert.deepEqual(body.questions.pick.criteria, {
      opt_0: "PostgreSQL",
      opt_1: "SQLite",
      opt_2: "MongoDB",
    });
    res.end(JSON.stringify(jevAnswer({ PostgreSQL: 0.7, SQLite: 0.2, MongoDB: 0.1 })(body)));
  });

  try {
    const { code, parsed } = await runHook(payload, { baseUrl: stub.url });
    assert.equal(code, 0);
    assert.equal(parsed?.cancel, false);
    assert.deepEqual(parsed?.overrideInput?.options, [
      "PostgreSQL (70.0%)",
      "SQLite (20.0%)",
      "MongoDB (10.0%)",
    ]);
  } finally {
    await stub.close();
  }
});

test("PostToolUse captures the chosen answer and the next question's state includes it", { skip: sqliteSkip }, async () => {
  let stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ Postgres: 0.7, SQLite: 0.3 })(body))));
  try {
    const q1 = `DB choice ${Date.now()}?`;
    await runHook(realPayload({ question: q1, options: ["Postgres", "SQLite"] }), { baseUrl: stub.url });
    await runPostHook({
      hookName: "tool_call",
      tool_call: { id: "call-1", name: "ask_question", input: { question: q1, options: ["Postgres", "SQLite"] }, response: "Postgres" },
      postToolUse: { toolName: "ask_question", response: "Postgres" },
    });
  } finally {
    await stub.close();
  }

  let capturedState = null;
  stub = await startStub((body, res) => {
    capturedState = body.state;
    res.end(JSON.stringify(jevAnswer({ Yes: 0.9, No: 0.1 })(body)));
  });
  try {
    const q2 = `Use pooling ${Date.now()}?`;
    await runHook(realPayload({ question: q2, options: ["Yes", "No"] }), { baseUrl: stub.url });
    assert.match(capturedState, /Recent decisions in this session:/);
    assert.match(capturedState, /Postgres/);
  } finally {
    await stub.close();
  }
});

test("the installer drops the prompt-steering skill and rules into a real .cline home", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "jev-fake-home-"));
  execFileSync(process.execPath, [join(REPO, "scripts", "install-hook.mjs")], {
    env: { ...process.env, HOME: fakeHome },
    stdio: "pipe",
  });
  const skill = join(fakeHome, ".cline", "skills", "jev-percentages", "SKILL.md");
  const rules = join(fakeHome, ".cline", "rules", "cline-option-scorer.md");
  assert.ok(existsSync(skill), "skill installed into the given home");
  assert.ok(existsSync(rules), "rules installed into the given home");
  assert.match(readFileSync(rules, "utf8"), /2-5/, "rules state the option cap");
  assert.ok(existsSync(join(fakeHome, ".cline", "hooks", "PreToolUse.cjs")));
});
