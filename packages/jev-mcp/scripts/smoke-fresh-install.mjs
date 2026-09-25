#!/usr/bin/env node
// Fresh-install smoke test for @donbee/jev-mcp — run `npm run verify && npm run
// smoke` before every release. Packs the package, installs the tarball into a
// clean prefix with an EMPTY $HOME, then exercises every published surface like
// a brand-new user: both bins, the documented npx CLI invocation (against the
// local tarball), a real CLI score, and an MCP handshake with one real scoring
// call. Needs network access for the real Jev calls.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "jev-mcp-smoke-"));
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
    env: { ...process.env, ...env, HOME: env.HOME ?? home },
    timeout: 90_000,
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};

// The checks below hit the real free endpoint, which occasionally exceeds the
// client's 10s timeoutMs and fails open. Retry once before believing a failure,
// so a single slow call cannot fail a release with a message that looks like a
// regression.
const LIVE_ATTEMPTS = 3;
const liveChecks = [];
const liveCheck = (label, fn) => liveChecks.push([label, fn]);

console.log(`[smoke] node ${process.versions.node}, packing ${pkg.name}@${pkg.version} …`);
mkdirSync(work, { recursive: true });

// 1) pack — the exact artifact npm would publish
const tarball = join(
  tmp,
  execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: PKG_DIR })
    .toString().trim().split("\n").pop()
);

// 2) install into the clean prefix — new user's global install
const install = run("npm", ["install", "--prefix", prefix, tarball, "--no-audit", "--no-fund"]);
ok(install.status === 0, "tarball installs into a clean prefix", install.out.slice(-300));
const bins = join(prefix, "node_modules", ".bin");
for (const b of ["jev-option-scorer", "jev-mcp"])
  ok(existsSync(join(bins, b)), `bin present: ${b}`);
const installed = JSON.parse(readFileSync(join(prefix, "node_modules", pkg.name, "package.json"), "utf8"));
ok(installed.version === pkg.version, `installed version ${installed.version} matches repo`);

// 3) README CLI - the documented `npx -y -p <pkg> jev-option-scorer ...` shape,
// run against the LOCAL tarball so this validates the invocation (package-name
// npx would pick the jev-mcp bin = the JSON-RPC server, not the CLI).
let npx = { status: 1, out: "" };
liveCheck("npx CLI", () => {
  npx = run("npx", ["-y", "-p", tarball, "jev-option-scorer", "--question", "Smoke npx CLI works?", "--option", "yes", "--option", "no"]);
  return npx.status === 0 && /%/.test(npx.out);
});

// 4) installed CLI directly - the global-install README example
let cli = { status: 1, out: "" };
liveCheck("CLI", () => {
  cli = run(join(bins, "jev-option-scorer"), ["--question", "Smoke CLI works?", "--option", "yes", "--option", "no"]);
  return cli.status === 0 && /%/.test(cli.out);
});

// 5) MCP server: handshake + scoring calls through the jev-mcp bin
let mcpCode = -1;
let mcpOut = "";
liveCheck("MCP", async () => {
  const mcp = spawn(NODE, [join(prefix, "node_modules", pkg.name, "src", "mcp-server.js")], {
    env: { ...process.env, HOME: home }, cwd: work, stdio: ["pipe", "pipe", "pipe"],
  });
  mcpOut = "";
  mcp.stdout.on("data", (c) => (mcpOut += c));
  const send = (msg) => mcp.stdin.write(JSON.stringify(msg) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "score_options", arguments: { state: "smoke context", question: `Smoke MCP scoring works? ${Date.now()}`, options: ["yes", "no"] } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "score_options", arguments: { state: "smoke context", question: "Auto?", options: ["yes", "no"], autoAnswer: true } } });
  mcp.stdin.end();
  mcpCode = await new Promise((res) => {
    const t = setTimeout(() => { mcp.kill(); res(-1); }, 30_000);
    mcp.on("close", (c) => { clearTimeout(t); res(c); });
  });
  return mcpCode === 0 && /enrichedOptions/.test(mcpOut);
});

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

ok(npx.status === 0 && /%/.test(npx.out), "documented npx CLI invocation scores with percentages", npx.out.slice(-300));
ok(cli.status === 0 && /%/.test(cli.out), "jev-option-scorer bin scores with percentages", cli.out.slice(-300));
ok(mcpCode === 0 && /"name"\s*:\s*"score_options"/.test(mcpOut), "MCP server answers initialize + tools/list", mcpOut.slice(0, 300));
ok(/enrichedOptions/.test(mcpOut), "MCP server returns enriched option labels", mcpOut.slice(-300));
ok(/DO NOT ask the user/.test(mcpOut), "autoAnswer response carries the skip-asking directive", mcpOut.slice(-300));

if (failures === 0) {
  rmSync(tmp, { recursive: true, force: true });
  console.log(`[smoke] PASS — fresh install of ${pkg.name}@${pkg.version} behaves like a brand-new user expects`);
} else {
  console.error(`[smoke] FAIL — ${failures} check(s) failed; artifacts kept at ${tmp}`);
  process.exit(1);
}
