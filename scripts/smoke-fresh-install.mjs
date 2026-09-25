#!/usr/bin/env node
// Fresh-install smoke test — run `npm run verify && npm run smoke` before every release.
// Packs the current tree, installs the tarball into a clean prefix with an EMPTY
// $HOME, and exercises every surface exactly like a brand-new user following the
// README: bins, hook installer, one real enrichment, JSONL + SQLite state (incl.
// the legacy-trail backfill), zero-config CLI, MCP handshake, README uninstall.
// Needs Node >= 22.5 (the engines floor) and network access for the real Jev calls.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [MAJ, MIN] = process.versions.node.split(".").map(Number);
if (MAJ < 22 || (MAJ === 22 && MIN < 5)) {
  console.error(`smoke needs Node >= 22.5 (node:sqlite), running ${process.versions.node}`);
  process.exit(1);
}

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "jev-smoke-"));
const prefix = join(tmp, "prefix");
const home = join(tmp, "home"); // brand-new user: empty $HOME, no config file
const work = join(tmp, "work"); // cwd with no package.json/.git/.cline ancestors
let failures = 0;

const ok = (cond, label, detail = "") =>
  cond ? console.log(`  ok  ${label}`)
       : (failures++, console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`));

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...env, HOME: env.HOME ?? home }, // config can ONLY come from the fake home
    timeout: 90_000,
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};

// Steps 5-8 talk to the real free endpoint, which occasionally takes longer than
// the hook's 10s timeoutMs. That fails the hook open and costs four assertions
// with a message that reads like a regression but is really one slow call, and
// it aborts the chain before the package smokes. So those steps are DECLARED
// here, retried once, and only then asserted - still real end-to-end calls, just
// not hostage to a single hiccup.
const LIVE_ATTEMPTS = 3;
const liveChecks = [];
const liveCheck = (label, fn) => liveChecks.push([label, fn]);

console.log(`[smoke] node ${process.versions.node}, packing ${pkg.name}@${pkg.version} …`);
mkdirSync(work, { recursive: true });

// 1) pack — the exact artifact npm would publish
const tarball = join(
  tmp,
  execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: REPO })
    .toString().trim().split("\n").pop()
);

// 2) install into the clean prefix — new user's global install
const install = run("npm", ["install", "--prefix", prefix, tarball, "--no-audit", "--no-fund"]);
ok(install.status === 0, "tarball installs into a clean prefix", install.out.slice(-300));
const bins = join(prefix, "node_modules", ".bin");
for (const b of ["cline-option-scorer", "cline-jev-mcp", "cline-option-scorer-install-hook"])
  ok(existsSync(join(bins, b)), `bin present: ${b}`);
const installed = JSON.parse(readFileSync(join(prefix, "node_modules", pkg.name, "package.json"), "utf8"));
ok(installed.version === pkg.version, `installed version ${installed.version} matches repo`);

// 3) pre-seed a legacy JSONL trail — proves the backfill keeps the state column
const logs = join(home, ".cline", "data", "logs");
mkdirSync(logs, { recursive: true });
writeFileSync(
  join(logs, "jev-hook.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), event: "enriched", question: "Legacy smoke?", state: "Legacy smoke? (ctx)", enriched: ["A (60.0%)", "B (40.0%)"] }) + "\n"
);

// 4) hook installer, as README says, into the new user's home
const inst = run(join(bins, "cline-option-scorer-install-hook"));
ok(inst.status === 0, "install-hook exits 0", inst.out.slice(-300));
const hooks = join(home, ".cline", "hooks");
for (const f of ["PreToolUse.cjs", "PostToolUse.cjs", "jev-hook-lib.cjs"])
  ok(existsSync(join(hooks, f)), `hook file installed: ${f}`);
ok(readFileSync(join(hooks, "jev-hook-lib.cjs"), "utf8").includes("state TEXT"), "installed lib carries the state schema");
// Prompt steering must reach real sessions: without these files the model never
// learns the 2-5 option rule or what happens to typed answers.
const skillFile = join(home, ".cline", "skills", "jev-percentages", "SKILL.md");
const rulesFile = join(home, ".cline", "rules", "cline-option-scorer.md");
ok(existsSync(skillFile), "skill installed: ~/.cline/skills/jev-percentages/SKILL.md");
ok(existsSync(rulesFile), "rules installed: ~/.cline/rules/cline-option-scorer.md");
ok(/2-5/.test(readFileSync(skillFile, "utf8")), "installed skill states the 2-5 option cap");
ok(/dismiss/i.test(readFileSync(skillFile, "utf8")), "installed skill explains typed/dismissed answers");

// 5) one real enrichment through the installed hook (anonymous free model)
let q = "";
let hookRun = { status: 1, stdout: "", stderr: "" };
liveCheck("hook enrichment", () => {
  q = `Smoke: fresh install works end to end? ${Date.now()}`;
  hookRun = spawnSync(NODE, [join(hooks, "PreToolUse.cjs")], {
    input: JSON.stringify({
      hookName: "tool_call",
      preToolUse: { toolName: "ask_question", parameters: { question: q, options: ["works", "broken"] } },
      tool_call: { name: "ask_question", input: { question: q, options: ["works", "broken"] } },
    }),
    encoding: "utf8", env: { ...process.env, HOME: home }, cwd: work, timeout: 90_000,
  });
  return hookRun.status === 0 && /"cancel":false/.test(hookRun.stdout || "");
});

// 7) zero-config CLI - README's first global-install example
let cli = { status: 1, out: "" };
liveCheck("CLI", () => {
  cli = run(join(bins, "cline-option-scorer"), ["--question", "Smoke CLI works?", "--option", "yes", "--option", "no"], { HOME: home });
  return cli.status === 0 && /%/.test(cli.out);
});

// 8) MCP server: handshake + scoring calls that must reach the audit trail.
// autoAnswer is opt-in: the same call with the flag must say DO NOT ASK and
// record the decision, so a brand-new install proves the whole feature.
let mcpCode = -1;
let mcpOut = "";
let mcpQ = "";
liveCheck("MCP", async () => {
  mcpQ = `Smoke MCP scoring works? ${Date.now()}`;
  const mcp = spawn(NODE, [join(prefix, "node_modules", pkg.name, "mcp-server.js")], {
    env: { ...process.env, HOME: home }, cwd: work, stdio: ["pipe", "pipe", "pipe"],
  });
  mcpOut = "";
  mcp.stdout.on("data", (c) => (mcpOut += c));
  const send = (msg) => mcp.stdin.write(JSON.stringify(msg) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "score_cline_options", arguments: { state: "smoke context", question: mcpQ, options: ["yes", "no"] } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "score_cline_options", arguments: { state: "smoke context", question: mcpQ, options: ["yes", "no"], autoAnswer: true } } });
  mcp.stdin.end();
  mcpCode = await new Promise((res) => {
    const t = setTimeout(() => { mcp.kill(); res(-1); }, 30_000);
    mcp.on("close", (c) => { clearTimeout(t); res(c); });
  });
  return mcpCode === 0 && /enrichedOptions/.test(mcpOut);
});

// Run the live checks, one retry each, then assert in detail below.
// Three attempts, not one: the free endpoint intermittently needs longer than
// the 10s default timeout, and a single hiccup must not fail a release. Still
// fully zero-config - the alternative (seeding a config file with a bigger
// timeoutMs) would stop these checks proving the zero-config path.
for (const [label, fn] of liveChecks) {
  let pass = false;
  for (let attempt = 1; attempt <= LIVE_ATTEMPTS && !pass; attempt++) {
    if (attempt > 1) {
      console.log(`  ...  retrying "${label}" (attempt ${attempt}/${LIVE_ATTEMPTS}; the free endpoint is occasionally slow)`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    pass = await fn();
  }
}

ok(hookRun.status === 0, "PreToolUse exits 0", (hookRun.stderr || "").slice(-300));
ok(/"cancel":false/.test(hookRun.stdout || ""), "hook enriches and allows the question");
ok(/\(\d+\.?\d*%\)/.test(hookRun.stdout || ""), "percentages present in override");

// 6) audit trail: JSONL + SQLite, live row AND backfilled legacy row
const trail = readFileSync(join(logs, "jev-hook.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const hookRow = trail.find((e) => e.event === "enriched" && e.question === q);
ok(typeof hookRow?.state === "string" && hookRow.state.includes(q), "JSONL enriched row records the state");
const { DatabaseSync } = await import("node:sqlite");
const d = new DatabaseSync(join(logs, "jev-hook.db"));
const cols = d.prepare("SELECT COUNT(*) n FROM pragma_table_info('events') WHERE name='state'").get().n;
ok(cols === 1, "SQLite events table has the state column");
const dbLive = d.prepare("SELECT state FROM events WHERE event='enriched' AND question=?").get(q);
ok(typeof dbLive?.state === "string" && dbLive.state.includes(q), "SQLite live row stores the state");
const dbLegacy = d.prepare("SELECT state FROM events WHERE event='enriched' AND question='Legacy smoke?'").get();
ok(typeof dbLegacy?.state === "string", "backfilled legacy row keeps its state");
d.close();

ok(cli.status === 0 && /%/.test(cli.out), "zero-config CLI scores with percentages", cli.out.slice(-300));

ok(mcpCode === 0 && /"name"\s*:\s*"(score_cline_options|jev-percent)"/.test(mcpOut), "MCP server answers initialize + tools/list", mcpOut.slice(0, 300));
ok(/enrichedOptions/.test(mcpOut), "MCP server returns enriched option labels", mcpOut.slice(-300));
ok(/DO NOT ask the user/.test(mcpOut), "autoAnswer response carries the skip-asking directive");
const mcpRows = readFileSync(join(logs, "jev-hook.jsonl"), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l)).filter((e) => e.question === mcpQ);
const mcpSeq = mcpRows.map((e) => `${e.event}/${e.source}`).join(",");
ok(
  mcpSeq.includes("intercept/mcp,enriched/mcp"),
  "MCP-scored questions reach the audit trail (source mcp)",
  JSON.stringify(mcpRows.map((e) => [e.event, e.source]))
);
ok(typeof mcpRows.find((e) => e.event === "enriched")?.state === "string", "MCP enriched row records the state sent to Jev");
const mcpAuto = mcpRows.find((e) => e.event === "enriched" && typeof e.reason === "string" && e.reason.startsWith("auto_answer: "));
ok(typeof mcpAuto?.reason === "string", "autoAnswer records the decision on the audit row", JSON.stringify(mcpRows.slice(-2)));

// 9) README uninstall — the three files go away
for (const f of ["PreToolUse.cjs", "PostToolUse.cjs", "jev-hook-lib.cjs"]) rmSync(join(hooks, f), { force: true });
rmSync(join(home, ".cline", "skills", "jev-percentages"), { recursive: true, force: true });
rmSync(join(home, ".cline", "rules", "cline-option-scorer.md"), { force: true });
ok(
  !existsSync(join(hooks, "PreToolUse.cjs")) && !existsSync(join(hooks, "jev-hook-lib.cjs")) &&
  !existsSync(skillFile) && !existsSync(rulesFile),
  "README uninstall removes hooks, skill and rules"
);

if (failures === 0) {
  rmSync(tmp, { recursive: true, force: true });
  console.log(`[smoke] PASS — fresh install of ${pkg.name}@${pkg.version} behaves like a brand-new user expects`);
} else {
  console.error(`[smoke] FAIL — ${failures} check(s) failed; artifacts kept at ${tmp}`);
  process.exit(1);
}

