import { configPaths, loadFileConfig, resolveConfig } from "../src/jev-config.js";

// Never print secrets: this script is run by `npm test`, so its output lands in
// CI logs and terminals. Keys are reported by length only.
const redact = (cfg) => ({
  ...cfg,
  opencodeApiKey: cfg.opencodeApiKey ? `«${String(cfg.opencodeApiKey).length} chars»` : null,
  typesafeApiKey: cfg.typesafeApiKey ? `«${String(cfg.typesafeApiKey).length} chars»` : null,
});

const c1 = resolveConfig({});
console.log("defaults:", JSON.stringify(redact(c1)));

const c2 = resolveConfig({ provider: "zen", model: "jev-1.13", timeoutMs: 5000 });
console.log("overrides:", JSON.stringify(redact(c2)));

console.log("paths-from-tmp:", JSON.stringify(configPaths("/tmp")));
console.log("paths-from-here:", JSON.stringify(configPaths(process.cwd())));
const file = loadFileConfig();
console.log("file:", JSON.stringify({ path: file.path, keys: Object.keys(file.values) }));
