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

function startStub(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((res) => s.close(res)) }));
  });
}

function jevAnswer(probabilities) {
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  const normalized = {};
  for (const [k, v] of Object.entries(probabilities)) {
    const slug = k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    normalized[slug] = v / sum;
  }
  const topSlug = Object.entries(normalized).sort((a, b) => b[1] - a[1])[0][0];
  return (body) => ({
    model: "jev-1.13-free",
    answers: {
      pick: {
        choice: topSlug,
        confidence: normalized[topSlug],
        probabilities: normalized,
      },
    },
  });
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
