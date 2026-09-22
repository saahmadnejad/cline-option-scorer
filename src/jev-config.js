// jev-config.js — one config source for every surface (CLI, hook, plugin, MCP).
// ALL configuration lives in `cline-jev.json`. No environment variable is read,
// ever — not even $HOME (the OS home directory comes from node:os.homedir()).
// Precedence per key (highest wins): explicit arg > config file > default.
//
// The config file is searched in:
//   1. <nearest ancestor of cwd containing package.json, .git, or .cline>/
//   2. <home>/.cline/
//   3. <home>/.config/cline-jev/
// First existing file wins; the rest are ignored (no deep merging — one file,
// one owner, no surprise blends of a project file with a home file). A bare
// `./cline-jev.json` is only honored when cwd itself is a project root (case 1)
// — a stray file in /tmp or ~/ can never silently change keys, and secrets stay
// out of repos.
//
// Shape (all optional):
//   { "provider": "zen-free|zen|typesafe", "model": "jev-1.13-free",
//     "baseUrl": "https://…", "typesafeApiKey": "…", "opencodeApiKey": "…",
//     "timeoutMs": 10000, "logDir": "~/.cline/data/logs" }
// Unknown keys are ignored so the file stays forward-compatible.
//
// CJS-safe: builtin access must not use static `import` (stripped in the
// generated CJS lib) and must not use top-level await (that would make the
// file an ES module graph, which `require()` refuses to load). `require`
// exists in CJS; under ESM, `module.createRequire` gives the same sync
// loader without going async.
import { createRequire as __createRequire } from "node:module";
const __req = typeof require === "function" ? require : __createRequire(import.meta.url);
const __fs = __req("node:fs");
const __path = __req("node:path");
const { existsSync: __existsSync, readFileSync: __readFileSync } = __fs;
const { dirname: __dir, join: __join, resolve: __resolve } = __path;

export const DEFAULTS = Object.freeze({
  provider: "zen-free",
  model: null, // null = provider default (jev-1.13-free | jev-1.13 | jev-1.13.0)
  baseUrl: null, // null = provider default endpoint
  timeoutMs: 10000,
  includeHistory: true, // PreToolUse enriches state with recent Q→A pairs from the audit trail
  historyTurns: 3, // how many past decision pairs to include
  maxStateChars: 2000, // hard cap for the whole state payload sent to Jev
});

const FILE_NAME = "cline-jev.json";
const ROOT_MARKERS = new Set(["package.json", ".git", ".cline"]);

// Find the project root by walking up from cwd. Returns null when nothing
// marks a root — callers then fall through to the home-level files.
function findProjectRoot(start) {
  let dir = __resolve(start);
  for (;;) {
    for (const m of ROOT_MARKERS) {
      if (__existsSync(__join(dir, m))) return dir;
    }
    const parent = __dir(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let __os = null;
function homeDir() {
  // node:os.homedir() — the OS home directory, deliberately NOT $HOME/$USERPROFILE.
  try {
    __os = __os || __req("node:os");
    return __os.homedir() || null;
  } catch {
    return null;
  }
}

// Ordered candidate files, most specific first.
export function configPaths(cwd = process.cwd()) {
  const paths = [];
  const root = findProjectRoot(cwd);
  if (root) paths.push(__join(root, FILE_NAME));
  const home = homeDir();
  if (home) {
    paths.push(__join(home, ".cline", FILE_NAME));
    paths.push(__join(home, ".config", "cline-jev", FILE_NAME));
  }
  return paths;
}

function readJson(path) {
  try {
    const raw = __readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

// First existing file wins; the rest are ignored (no deep merging — one file,
// one owner, no surprise blends of a project file with a home file).
export function loadFileConfig(cwd) {
  for (const p of configPaths(cwd)) {
    if (__existsSync(p)) return { path: p, values: readJson(p) };
  }
  return { path: null, values: {} };
}

// Merge one surface's inputs into the resolved config. `overrides` are explicit
// per-call values (CLI flags, tool args) and always win over the file.
//
// Only KNOWN keys are read out of `overrides` — unknown keys (state, question,
// options, …) are ignored, so whole argument objects can be passed straight in.
export function resolveConfig(overrides = {}, cwd) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const { path, values: file } = loadFileConfig(cwd);
  const num = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fb;
  };
  const int = (v, fb) => {
    // like num(), but allows 0 (historyTurns: 0 must disable history, not fall back)
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : fb;
  };
  return {
    provider: o.provider ?? file.provider ?? DEFAULTS.provider,
    model: o.model ?? file.model ?? DEFAULTS.model,
    baseUrl: o.baseUrl ?? file.baseUrl ?? DEFAULTS.baseUrl,
    // Keys have no defaults — absent means anonymous (zen-free) or an error
    // naming the missing provider (zen / typesafe).
    opencodeApiKey: o.opencodeApiKey ?? file.opencodeApiKey ?? null,
    typesafeApiKey: o.typesafeApiKey ?? file.typesafeApiKey ?? null,
    timeoutMs: num(o.timeoutMs ?? file.timeoutMs, DEFAULTS.timeoutMs),
    // Where the hook appends its audit log (default: <home>/.cline/data/logs).
    logDir: o.logDir ?? file.logDir ?? null,
    // Context enrichment: how much conversation history goes into `state`.
    includeHistory: o.includeHistory ?? file.includeHistory ?? DEFAULTS.includeHistory,
    historyTurns: int(o.historyTurns ?? file.historyTurns, DEFAULTS.historyTurns),
    maxStateChars: num(o.maxStateChars ?? file.maxStateChars, DEFAULTS.maxStateChars),
    _source: path, // which file contributed, or null — useful in --help / logs
  };
}
