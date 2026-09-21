#!/usr/bin/env node
// Installs hooks/PreToolUse.js into the Cline hooks directory so that EVERY
// ask_question / ask_followup_question is scored with Jev before it runs.
//
// HOW CLINE DISCOVERS HOOK FILES (from @cline/core):
//   1. it scans each existing hooks search path - non-recursively - and picks
//      files whose extension is one of "", .sh, .bash, .zsh, .js, .mjs, .cjs,
//      .ts, .mts, .cts, .py, .ps1;
//   2. the basename (lowercased, extension stripped) must be a hook event name,
//      e.g. `PreToolUse.js` -> "pretooluse" -> PreToolUse -> tool_call;
//   3. EVERY matching file runs (results applied in path order), so a stray
//      `pretooluse.sh` next to this one would also run. We warn about that.
//
// Usage:
//   npm run install:hook                     # -> ~/.cline/hooks/PreToolUse.js
//   node scripts/install-hook.mjs --dir <d>  # custom hooks dir (or $CLINE_HOOKS_DIR)
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSIONS = new Set(["", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".py", ".ps1"]);
const EVENT_NAMES = new Map([
  ["taskstart", "TaskStart"],
  ["taskresume", "TaskResume"],
  ["taskcancel", "TaskCancel"],
  ["taskcomplete", "TaskComplete"],
  ["taskerror", "TaskError"],
  ["pretooluse", "PreToolUse"],
  ["posttooluse", "PostToolUse"],
  ["userpromptsubmit", "UserPromptSubmit"],
  ["precompact", "PreCompact"],
  ["sessionshutdown", "SessionShutdown"],
]);
const hookEventName = (file) => {
  const ext = extname(file).toLowerCase();
  return EXTENSIONS.has(ext) ? EVENT_NAMES.get(basename(file, ext).trim().toLowerCase()) : undefined;
};

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "..", "hooks", "PreToolUse.js");

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf("--dir");
const targetDir = resolve(
  dirFlag >= 0 && argv[dirFlag + 1]
    ? argv[dirFlag + 1]
    : process.env.CLINE_HOOKS_DIR || join(homedir(), ".cline", "hooks")
);
const target = join(targetDir, "PreToolUse.js");

if (!existsSync(SOURCE)) {
  console.error(`[install-hook] source not found: ${SOURCE}`);
  process.exit(1);
}
mkdirSync(targetDir, { recursive: true });

const source = readFileSync(SOURCE, "utf8");
if (existsSync(target)) {
  const current = readFileSync(target, "utf8");
  if (current === source) {
    chmodSync(target, 0o755);
    console.log(`[install-hook] already up to date: ${target}`);
  } else {
    const backup = `${target}.bak`;
    writeFileSync(backup, current);
    console.log(`[install-hook] backed up previous hook -> ${backup}`);
  }
}
copyFileSync(SOURCE, target);
chmodSync(target, 0o755);

// Fail loudly if the copy is not byte-identical or not executable.
const installed = readFileSync(target, "utf8");
if (installed !== source) {
  console.error(`[install-hook] copy verification FAILED for ${target}`);
  process.exit(1);
}

const rivals = readdirSync(targetDir).filter((f) => f !== "PreToolUse.js" && hookEventName(f) === "PreToolUse");
console.log(`[install-hook] installed + verified: ${target} (mode 755)`);
if (rivals.length) {
  console.warn(
    `[install-hook] warning: ${rivals.join(", ")} also maps to PreToolUse in ${targetDir}; ` +
      `Cline runs every match, so remove it if the question gets scored twice.`
  );
}
console.log("[install-hook] open a NEW Cline session so the hook is picked up;");
console.log("[install-hook] verify with: tail -n 5 ~/.cline/data/logs/jev-hook.jsonl");
