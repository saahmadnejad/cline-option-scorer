// jev-config.js — one config source for every surface (CLI, MCP, etc.)
// Configuration lives in `jev.json` or `cline-jev.json`.
// Precedence per key: explicit arg > config file > default.
//
// Searched locations (first existing file wins):
//   1. <nearest ancestor of cwd containing package.json, .git, or .cline>/jev.json or cline-jev.json
//   2. <home>/.config/jev/jev.json
//   3. <home>/.cline/cline-jev.json
//   4. <home>/.config/cline-jev/cline-jev.json
import { createRequire as __createRequire } from "node:module";
const __req = typeof require === "function" ? require : __createRequire(import.meta.url);
const __fs = __req("node:fs");
const __path = __req("node:path");
const { existsSync: __existsSync, readFileSync: __readFileSync } = __fs;
const { dirname: __dir, join: __join, resolve: __resolve } = __path;

export const DEFAULTS = Object.freeze({
  provider: "zen-free",
  model: null,
  baseUrl: null,
  timeoutMs: 10000,
  autoAnswer: false,
});

const FILE_NAMES = ["jev.json", "cline-jev.json"];
const ROOT_MARKERS = new Set(["package.json", ".git", ".cline"]);

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
  try {
    __os = __os || __req("node:os");
    return __os.homedir() || null;
  } catch {
    return null;
  }
}

export function configPaths(cwd = process.cwd()) {
  const paths = [];
  const root = findProjectRoot(cwd);
  if (root) {
    for (const f of FILE_NAMES) paths.push(__join(root, f));
  }
  const home = homeDir();
  if (home) {
    paths.push(__join(home, ".config", "jev", "jev.json"));
    paths.push(__join(home, ".cline", "cline-jev.json"));
    paths.push(__join(home, ".config", "cline-jev", "cline-jev.json"));
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

export function loadFileConfig(cwd) {
  for (const p of configPaths(cwd)) {
    if (__existsSync(p)) return { path: p, values: readJson(p) };
  }
  return { path: null, values: {} };
}

export function resolveConfig(overrides = {}, cwd) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const { path, values: file } = loadFileConfig(cwd);
  const num = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fb;
  };
  return {
    provider: o.provider ?? file.provider ?? DEFAULTS.provider,
    model: o.model ?? file.model ?? DEFAULTS.model,
    baseUrl: o.baseUrl ?? file.baseUrl ?? DEFAULTS.baseUrl,
    opencodeApiKey: o.opencodeApiKey ?? file.opencodeApiKey ?? null,
    typesafeApiKey: o.typesafeApiKey ?? file.typesafeApiKey ?? null,
    timeoutMs: num(o.timeoutMs ?? file.timeoutMs, DEFAULTS.timeoutMs),
    autoAnswer: o.autoAnswer ?? file.autoAnswer ?? DEFAULTS.autoAnswer,
    _source: path,
  };
}
