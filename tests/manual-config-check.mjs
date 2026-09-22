import { configPaths, loadFileConfig, resolveConfig } from "../src/jev-config.js";

const c1 = resolveConfig({});
console.log("defaults:", JSON.stringify(c1));

const c2 = resolveConfig({ provider: "zen", model: "jev-1.13", timeoutMs: 5000 });
console.log("overrides:", JSON.stringify(c2));

console.log("paths-from-tmp:", JSON.stringify(configPaths("/tmp")));
console.log("paths-from-here:", JSON.stringify(configPaths(process.cwd())));
console.log("file:", JSON.stringify(loadFileConfig()));
