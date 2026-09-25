#!/usr/bin/env node
// Fresh-install smoke test for @donbee/cline-plugin-jev-percent — run
// `npm run verify && npm run smoke` before every release. Packs the package,
// installs the tarball into a clean prefix with an EMPTY $HOME, then walks the
// README path like a brand-new user: bins, hook installer (hooks + skill +
// rules), one real enrichment through the installed hook, the CLI, and the
// plugin module import (@cline/sdk) that `cline plugin install` performs.
// Needs network access for the real Jev calls.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "cline-plugin-smoke-"));
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

console.log(`[smoke] node ${process.versions.node}, packing ${pkg.name}@${pkg.version} …`);
mkdirSync(work, { recursive: true });

// 1) pack — the exact artifact npm would publish
const tarball = join(
  tmp,
  execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: PKG_DIR })
    .toString().trim().split("\n").pop()
);

// 2) install into the clean prefix — new user's global install. @cline/sdk comes
// along because `cline plugin install` imports the plugin with the SDK present
// (it is an optional peerDependency, so the bare tarball install omits it).
const install = run("npm", ["install", "--prefix", prefix, tarball, "@cline/sdk", "--no-audit", "--no-fund"]);
ok(install.status === 0, "tarball installs into a clean prefix (with @cline/sdk)", install.out.slice(-300));
const bins = join(prefix, "node_modules", ".bin");
for (const b of ["cline-option-scorer", "cline-option-scorer-install-hook"])
  ok(existsSync(join(bins, b)), `bin present: ${b}`);
const installed = JSON.parse(readFileSync(join(prefix, "node_modules", pkg.name, "package.json"), "utf8"));
ok(installed.version === pkg.version, `installed version ${installed.version} matches repo`);

// 3) plugin module import — what `cline plugin install` does first. A syntax
// error, a bad relative import or a missing SDK surfaces here.
const plugin = join(prefix, "node_modules", pkg.name, "cline-plugin.js");
const imported = run(NODE, ["--input-type=module", "-e",
  `const m = await import(${JSON.stringify(`file://${plugin}`)});` +
  `const p = m.default;` +
  `if (!p || typeof p.setup !== "function" || !p.hooks?.beforeTool) {` +
  `  console.error("bad plugin shape: " + JSON.stringify(Object.keys(p ?? {}))); process.exit(1);` +
  `}` +
  `console.log("plugin ok: " + p.name);`],
  { cwd: work });
ok(imported.status === 0 && /plugin ok/.test(imported.out), "plugin module imports and exposes setup + beforeTool", imported.out.slice(-300));

// 4) hook installer, as README says, into the new user's home
const inst = run(join(bins, "cline-option-scorer-install-hook"));
ok(inst.status === 0, "install-hook exits 0", inst.out.slice(-300));
const hooks = join(home, ".cline", "hooks");
for (const f of ["PreToolUse.cjs", "PostToolUse.cjs", "jev-hook-lib.cjs"])
  ok(existsSync(join(hooks, f)), `hook file installed: ${f}`);
const skillFile = join(home, ".cline", "skills", "jev-percentages", "SKILL.md");
const rulesFile = join(home, ".cline", "rules", "cline-option-scorer.md");
ok(existsSync(skillFile), "skill installed: ~/.cline/skills/jev-percentages/SKILL.md");
ok(existsSync(rulesFile), "rules installed: ~/.cline/rules/cline-option-scorer.md");

// 5) one real enrichment through the installed hook (anonymous free model)
const q = `Smoke: fresh install works end to end? ${Date.now()}`;
const payload = JSON.stringify({
  hookName: "tool_call",
  preToolUse: { toolName: "ask_question", parameters: { question: q, options: ["works", "broken"] } },
  tool_call: { name: "ask_question", input: { question: q, options: ["works", "broken"] } },
});
const hookRun = spawnSync(NODE, [join(hooks, "PreToolUse.cjs")], {
  input: payload, encoding: "utf8", env: { ...process.env, HOME: home }, cwd: work, timeout: 90_000,
});
ok(hookRun.status === 0, "PreToolUse exits 0", (hookRun.stderr || "").slice(-300));
ok(/"cancel":false/.test(hookRun.stdout || ""), "hook enriches and allows the question");
ok(/\(\d+\.?\d*%\)/.test(hookRun.stdout || ""), "percentages present in override");

// 6) zero-config CLI — README's global-install example
const cli = run(join(bins, "cline-option-scorer"), ["--question", "Smoke CLI works?", "--option", "yes", "--option", "no"]);
ok(cli.status === 0 && /%/.test(cli.out), "zero-config CLI scores with percentages", cli.out.slice(-300));

// 7) README uninstall — the hook files and steering files go away
for (const f of ["PreToolUse.cjs", "PostToolUse.cjs", "jev-hook-lib.cjs"]) rmSync(join(hooks, f), { force: true });
rmSync(skillFile, { recursive: true, force: true });
rmSync(rulesFile, { force: true });
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
