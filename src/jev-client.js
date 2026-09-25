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

// Criterion IDs are positional (`opt_0`, `opt_1`, …) and `criteria` doubles as
// the ID → label map that decodes the response. Labels are arbitrary text, so
// deriving the ID from the label is lossy: "A & B" and "A-B" both normalize to
// `a_b`, and two labels sharing their first 40 characters truncate to the same
// key — either way one option overwrites the other in `criteria` and the wrong
// option gets the probability.
function buildCriteria(options) {
  const criteria = {};
  options.forEach((opt, i) => {
    criteria[`opt_${i}`] = opt;
  });
  return criteria;
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

  const criteria = buildCriteria(options);

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
  for (const [id, opt] of Object.entries(criteria)) probabilities[opt] = ans.probabilities[id] ?? 0;
  // `ans.choice` is a criterion ID — decode it back through the same map.
  const choice = criteria[ans.choice] ?? ans.choice;
  return { choice, probabilities, confidence: ans.confidence ?? 0, model: json.model, provider };
}


export function printResult(question, result) {
  console.log(`\nQ: ${question}`);
  console.log(`Jev [${result.provider}/${result.model}]: ${result.choice} (${(result.confidence * 100).toFixed(0)}% conf)`);
  for (const [opt, prob] of Object.entries(result.probabilities)) {
    console.log(`  ${opt.padEnd(22)} ${(prob * 100).toFixed(1)}%`);
  }
}

// One line the model (or the user, in a terminal) can read and repeat aloud:
// which question was decided and which option was picked, without asking.
export function autoDecisionLine(question, result) {
  return `Auto-answered (autoAnswer enabled): ${result.choice} (${((result.probabilities[result.choice] ?? 0) * 100).toFixed(1)}%) — question: ${question}`;
}
