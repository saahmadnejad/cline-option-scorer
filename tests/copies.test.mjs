// Drift guard for the hand-maintained copies.
//
// The split into packages/ shipped the same files as byte-identical copies with
// no shared module, so a fix applied in one place can silently miss the others
// (the slug() -> buildCriteria() fix had to be applied in five places, and
// packages/jev-mcp/src/jev-config.js already forked). This test does not remove
// that duplication - it makes it impossible to forget a copy by accident.
//
// A pair listed in IDENTICAL must stay byte-for-byte equal. A pair listed in
// DIVERGENT is a deliberate, documented difference: it must differ, and its
// module API must still match its source. Adding a new copy means adding it to
// one of the two lists, so no file is ever unclassified.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// Must never drift: a behavioural fix belongs in every copy.
const IDENTICAL = [
  ["src/jev-client.js", "packages/jev-mcp/src/jev-client.js"],
  ["src/jev-client.js", "packages/cline-plugin/src/jev-client.js"],
  ["src/jev-config.js", "packages/cline-plugin/src/jev-config.js"],
  ["src/cli.js", "packages/cline-plugin/src/cli.js"],
  ["src/cline-interceptor.js", "packages/cline-plugin/src/cline-interceptor.js"],
  ["src/jev-hook-core.js", "packages/cline-plugin/src/jev-hook-core.js"],
  ["cline-plugin.js", "packages/cline-plugin/cline-plugin.js"],
  ["hooks/PreToolUse.cjs", "packages/cline-plugin/hooks/PreToolUse.cjs"],
  ["hooks/PostToolUse.cjs", "packages/cline-plugin/hooks/PostToolUse.cjs"],
  ["scripts/install-hook.mjs", "packages/cline-plugin/scripts/install-hook.mjs"],
  ["skills/jev-percentages/SKILL.md", "packages/cline-plugin/skills/jev-percentages/SKILL.md"],
];

// Deliberately different surfaces - listed so nobody "fixes" them by copying
// over, and so a later divergence is noticed on purpose.
const DIVERGENT = [
  {
    root: "src/jev-config.js",
    copy: "packages/jev-mcp/src/jev-config.js",
    why: "the universal server has no decision trail, so it drops the history/logging keys and adds jev.json",
  },
  {
    root: "src/cli.js",
    copy: "packages/jev-mcp/src/cli.js",
    why: "no --cline-xml mode and no Cline-specific provider default",
  },
  {
    root: ".clinerules",
    copy: "packages/cline-plugin/.clinerules",
    why: "release-hygiene text must describe that package's own smoke (no MCP server, no SQLite backfill)",
  },
];

test("every hand-maintained copy is classified, and identical copies stay identical", () => {
  const drifted = IDENTICAL.filter(([a, b]) => read(a) !== read(b)).map(([a, b]) => `${a} != ${b}`);
  assert.deepEqual(drifted, [], `copies drifted - apply the fix to every copy:\n${drifted.join("\n")}`);
});

test("deliberately divergent copies still differ, and each says why", () => {
  for (const { root, copy, why } of DIVERGENT) {
    assert.ok(why.length > 20, `${copy} must record why it diverges from ${root}`);
    assert.notEqual(read(root), read(copy), `${copy} is supposed to diverge from ${root} (${why})`);
  }
  // Both copies of a divergent file must still be shipped and still be real
  // modules - a "divergent" copy must not quietly become a stub.
  for (const { copy } of DIVERGENT) {
    assert.ok(read(copy).length > 500, `${copy} looks truncated`);
  }
});

test("divergent config copies keep the same module API and shared defaults", async () => {
  const root = await import(join(REPO, "src/jev-config.js"));
  const copy = await import(join(REPO, "packages/jev-mcp/src/jev-config.js"));
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(root).sort());
  // The universal resolver drops the trail keys on purpose; everything both
  // surfaces share must still default to exactly the same value.
  for (const key of ["provider", "model", "baseUrl", "timeoutMs", "autoAnswer"]) {
    assert.deepEqual(copy.DEFAULTS[key], root.DEFAULTS[key], `DEFAULTS.${key} diverged`);
  }
  // autoAnswer must be a real false, never an accidental undefined: the plugin
  // and MCP paths only ever check `autoAnswer === true`.
  assert.equal(root.DEFAULTS.autoAnswer, false, "autoAnswer must default to explicit false");
  assert.equal(copy.DEFAULTS.autoAnswer, false, "autoAnswer must default to explicit false");
  for (const key of ["includeHistory", "historyTurns", "maxStateChars", "historyScope"]) {
    assert.equal(copy.DEFAULTS[key], undefined, `${key} is a Cline-surface key; it must not leak into the universal copy`);
  }
});
