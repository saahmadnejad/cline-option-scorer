#!/usr/bin/env node
// Usage (installed: npm install -g @donbee/cline-option-scorer):
//   cline-option-scorer --demo             # zen-free, no key
//   cline-option-scorer --demo --provider zen --model jev-1.13   # needs OPENCODE_API_KEY
//   cline-option-scorer --demo --provider typesafe              # needs TYPESAFE_API_KEY
//   cline-option-scorer --state "..." --question "..." --option "A" --option "B"
import { scoreOptions, printResult } from './jev-client.js';
import { interceptClineAsk, parseClineAsk } from './cline-interceptor.js';
import fs from 'node:fs';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((v, i) => { if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}
const has = (n) => process.argv.includes(`--${n}`);

const provider = arg('provider', 'zen-free');
if (arg('model', null)) process.env.JEV_MODEL = arg('model', null);

// Real Cline mode: --cline-xml "<ask_followup_question>..." or --cline-file path, or pipe via stdin
let clineXml = arg('cline-xml');
const clineFile = arg('cline-file');
if (clineFile) clineXml = fs.readFileSync(clineFile, 'utf8');
if (!clineXml && !process.stdin.isTTY) {
  try { clineXml = fs.readFileSync(0, 'utf8'); } catch {}
  if (clineXml && !clineXml.includes('<ask_followup_question')) clineXml = null;
}
if (clineXml) {
  const stateArg = arg('state');
  try {
    const r = await interceptClineAsk({ xml: clineXml, state: stateArg, provider });
    printResult(r.question, r);
    console.log('\n--- enriched Cline XML (paste back) ---\n' + r.enrichedXml);
  } catch (e) {
    console.error('[error] ' + e.message);
    process.exit(1);
  }
  process.exit(0);
}

let state = arg('state');
let question = arg('question');
let options = argAll('option');

if (has('demo') || (!state && !question)) {
  state = 'User is setting up CI/CD for a Java Maven project hosted on GitHub.';
  question = 'Which CI/CD platform should we integrate?';
  options = ['GitHub Actions', 'GitLab CI', 'Jenkins'];
}

if (!options.length) {
  console.error('Usage: cline-option-scorer --state "..." --question "..." --option "A" --option "B" [--provider zen-free|zen|typesafe]');
  process.exit(1);
}

try {
  const result = await scoreOptions({ state, question, options, provider });
  printResult(question, result);
} catch (e) {
  // offline / no key fallback: equal split so installer works on any system
  console.error(`[warn] ${e.message}\n[mock] equal split:`);
  const each = 1 / options.length;
  for (const o of options) console.log(`  ${o.padEnd(22)} ${(each * 100).toFixed(1)}% (mock)`);
}
