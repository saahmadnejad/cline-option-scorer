#!/usr/bin/env node
// Usage (installed: npm install -g @donbee/jev-mcp):
//   jev-option-scorer --state "..." --question "..." --option "A" --option "B"
//   jev-option-scorer --auto --question "..." --option "A" --option "B"   # pick Jev's top option, print what was chosen
import { scoreOptions, printResult, autoDecisionLine } from './jev-client.js';
import { resolveConfig } from './jev-config.js';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((v, i) => { if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}
const provider = arg('provider', null);
const model = arg('model', null); // explicit override — never routed through the environment

let state = arg('state');
let question = arg('question');
let options = argAll('option');

if (!state && !question) {
  console.error(
    'Usage: jev-option-scorer --state "..." --question "..." --option "A" --option "B" ' +
      '[--provider zen-free|zen|typesafe] [--model jev-1.13] [--auto]'
  );
  process.exit(1);
}

if (!options.length) {
  console.error('Usage: jev-option-scorer --state "..." --question "..." --option "A" --option "B" [--provider zen-free|zen|typesafe]');
  process.exit(1);
}

try {
  const overrides = {};
  if (provider) overrides.provider = provider;
  if (model) overrides.model = model;
  const cfg = resolveConfig(overrides);
  const auto = process.argv.includes("--auto") || cfg.autoAnswer === true;
  const result = await scoreOptions({ state, question, options, ...overrides });
  printResult(question, result);
  // Default off: without asking the user, say plainly what was decided.
  if (auto) console.log(`\n${autoDecisionLine(question, result)}`);
} catch (e) {
  // offline / no key fallback: equal split so installer works on any system
  console.error(`[warn] ${e.message}\n[mock] equal split:`);
  const each = 1 / options.length;
  for (const o of options) console.log(`  ${o.padEnd(22)} ${(each * 100).toFixed(1)}% (mock)`);
}
