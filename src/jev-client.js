// Jev client - works with TypeSafe direct + OpenCode Zen.
// Confirmed via https://models.dev/models/typesafe/jev-latest/ :
//   - opencode/jev-1.13-free ($0) and opencode/jev-1.13 ($0.04) via https://opencode.ai/zen/v1/systemone
//   - typesafe direct via https://api.typesafe.ai/v1/systemone, model jev-1.13.0 / jev-latest
// Endpoint shape is identical: { state, model, questions: { pick: { type:'choice', instructions, criteria } } }
//
// All tunables come from src/jev-config.js (args > env > cline-jev.json > defaults),
// so this module reads NO environment variables directly except through resolveConfig.
import { resolveConfig } from "./jev-config.js";

const PROVIDER_DEFAULTS = {
  typesafe: { baseUrl: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  zen: { baseUrl: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" },
  "zen-free": { baseUrl: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13-free" },
};

function slug(s) {
  const sl = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return (sl || "option").slice(0, 40);
}

export async function scoreOptions({ state, question, options, ...overrides }) {
  const cfg = resolveConfig(overrides);
  const provider = cfg.provider;
  const known = PROVIDER_DEFAULTS[provider];
  if (!known) throw new Error(`unknown provider ${provider}, use ${Object.keys(PROVIDER_DEFAULTS).join("|")}`);
  // A single option cannot be ranked, and an empty list would make Jev invent
  // criteria. Fail with a fixable message instead of sending a useless request.
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(`need at least 2 options to score, got ${Array.isArray(options) ? options.length : typeof options}`);
  }
  if (options.some((o) => typeof o !== "string" || !o.trim())) {
    throw new Error("every option must be a non-empty string");
  }

  const criteria = {};
  for (const opt of options) criteria[slug(opt)] = opt;

  const body = {
    state: state || question,
    model: cfg.model || known.model,
    questions: { pick: { type: "choice", instructions: question, criteria } },
  };

  const headers = { "Content-Type": "application/json" };
  const key = cfg.opencodeApiKey || cfg.typesafeApiKey;
  if (key) headers.Authorization = `Bearer ${key}`;
  // zen-free works anonymously; the paid providers fail here with a fixable
  // message instead of a bare 401 from the endpoint.
  else if (provider !== "zen-free") throw new Error(`Missing API key for provider ${provider}`);

  const res = await fetch(cfg.baseUrl || known.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jev ${provider} ${res.status} : ${text.slice(0, 500)}`);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Jev ${provider} returned non-JSON: ${text.slice(0, 500)}`);
  }
  const ans = json.answers?.pick;
  if (!ans?.probabilities) throw new Error("Bad Jev response: " + text.slice(0, 500));

  const probabilities = {};
  for (const opt of options) probabilities[opt] = ans.probabilities[slug(opt)] ?? 0;

  const choiceSlug = ans.choice;
  const choice = options.find((o) => slug(o) === choiceSlug) ?? choiceSlug;
  return { choice, probabilities, confidence: ans.confidence ?? 0, model: json.model, provider };
}


export function printResult(question, result) {
  console.log(`\nQ: ${question}`);
  console.log(`Jev [${result.provider}/${result.model}]: ${result.choice} (${(result.confidence * 100).toFixed(0)}% conf)`);
  for (const [opt, prob] of Object.entries(result.probabilities)) {
    console.log(`  ${opt.padEnd(22)} ${(prob * 100).toFixed(1)}%`);
  }
}
