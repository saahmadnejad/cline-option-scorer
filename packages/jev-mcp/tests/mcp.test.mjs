import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(here, "..", "src", "mcp-server.js");

// Parse the JSON request body before invoking the handler: `jevAnswer` echoes
// per-criterion-ID probabilities, so it must see the real `criteria` map.
function startStub(handler) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => handler(JSON.parse(raw || "{}"), res));
    });
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((res) => s.close(res)) }));
  });
}

// Mirrors the real API contract: response probabilities/choice are keyed by
// whatever criterion IDs appear in the REQUEST's `criteria` map (not the label
// text), so the stub echoes per-ID probabilities derived from the labels.
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

function runMcp(frames, cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jev-mcp-test-"));
  writeFileSync(join(dir, "package.json"), '{"name":"test"}');
  writeFileSync(join(dir, "jev.json"), JSON.stringify(cfg));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP_SERVER], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("MCP lists score_options and score_cline_options tools", async () => {
  const { code, out } = await runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(code, 0);
  assert.match(out, /"name":"score_options"/);
  assert.match(out, /"name":"score_cline_options"/);
});

test("MCP calls score_options successfully with calibrated percentages", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ A: 0.8, B: 0.2 })(body))));
  try {
    const { code, out } = await runMcp([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "score_options", arguments: { question: "Q?", options: ["A", "B"] } } },
    ], { baseUrl: stub.url });
    assert.equal(code, 0);
    assert.match(out, /enrichedOptions/);
    assert.match(out, /A \(80\.0%\)/);
    assert.match(out, /B \(20\.0%\)/);
    assert.ok(!out.includes("DO NOT ask"), "autoAnswer default off: no skip directive");
  } finally {
    await stub.close();
  }
});

test("MCP autoAnswer returns DO NOT ASK directive with chosen winner", async () => {
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer({ Winner: 0.9, Loser: 0.1 })(body))));
  try {
    const { code, out } = await runMcp([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "score_options", arguments: { question: "Auto?", options: ["Winner", "Loser"], autoAnswer: true } } },
    ], { baseUrl: stub.url });
    assert.equal(code, 0);
    assert.match(out, /DO NOT ask the user this question/);
    assert.match(out, /Auto-answered \(autoAnswer enabled\): Winner/);
  } finally {
    await stub.close();
  }
});

// Regression: labels colliding under the old slug derivation ("A & B" and
// "A-B" both became `a_b`; labels sharing their first 40 characters truncated
// to the same key) overwrote each other in `criteria`, so one option absorbed
// the other's probability. Criterion IDs must stay positional for any label.
test("MCP keeps colliding and over-length labels distinct", async () => {
  const longA = `${"x".repeat(40)} A`;
  const longB = `${"x".repeat(40)} B`;
  const options = ["A & B", "A-B", longA, longB];
  let seenCriteria = null;
  const stub = await startStub((body, res) => {
    seenCriteria = body.questions.pick.criteria;
    res.end(JSON.stringify(jevAnswer({ "A & B": 0.4, "A-B": 0.3, [longA]: 0.2, [longB]: 0.1 })(body)));
  });
  try {
    const { code, out } = await runMcp([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "score_options", arguments: { question: "Q?", options } } },
    ], { baseUrl: stub.url });
    assert.equal(code, 0);
    assert.deepEqual(seenCriteria, { opt_0: "A & B", opt_1: "A-B", opt_2: longA, opt_3: longB });
    for (const [label, pct] of [["A & B", "40.0"], ["A-B", "30.0"], [longA, "20.0"], [longB, "10.0"]]) {
      assert.ok(out.includes(`${label} (${pct}%)`), `expected ${label} (${pct}%) in ${out.slice(-400)}`);
    }
  } finally {
    await stub.close();
  }
});

// Regression: the Cline-facing alias must keep Cline's own <=5 schema limit
// (ask_followup_question rejects more), while the universal tool stays uncapped.
test("score_cline_options keeps Cline's 5-option cap, score_options stays universal", async () => {
  const many = ["a", "b", "c", "d", "e", "f"];
  const weights = { a: 0.67, b: 0.04, c: 0.06, d: 0.04, e: 0.02, f: 0.17 };
  const stub = await startStub((body, res) => res.end(JSON.stringify(jevAnswer(weights)(body))));
  try {
    const { out } = await runMcp([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "score_cline_options", arguments: { question: "Q?", options: many } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "score_options", arguments: { question: "Q?", options: many } } },
    ], { baseUrl: stub.url });
    const [alias, universal] = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.match(alias.result.content[0].text, /at most 5 labels/);
    assert.equal(alias.result.isError, true, "Cline alias rejects >5 so the model fixes the question");
    assert.equal(universal.result.isError, false, "universal tool scores any number of options");
    assert.match(universal.result.content[0].text, /enrichedOptions/);
  } finally {
    await stub.close();
  }
});
