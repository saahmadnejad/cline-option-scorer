// Jev client - works with TypeSafe direct + OpenCode Zen.
// Confirmed via https://models.dev/models/typesafe/jev-latest/ :
//   - opencode/jev-1.13-free ($0) and opencode/jev-1.13 ($0.04) via https://opencode.ai/zen/v1/systemone
//   - typesafe direct via https://api.typesafe.ai/v1/systemone, model jev-1.13.0 / jev-latest
// Endpoint shape is identical: { state, model, questions: { pick: { type:'choice', instructions, criteria } } }

export const PROVIDERS = {
  // direct TypeSafe - needs TYPESAFE_API_KEY from https://console.typesafe.ai/keys
  typesafe: {
    baseUrl: process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1/systemone',
    model: process.env.JEV_MODEL || 'jev-1.13.0',
    apiKey: () => process.env.TYPESAFE_API_KEY,
  },
  // OpenCode Zen paid - needs OPENCODE_API_KEY (opencode.ai/auth), model jev-1.13
  zen: {
    baseUrl: 'https://opencode.ai/zen/v1/systemone',
    model: process.env.JEV_MODEL || 'jev-1.13',
    apiKey: () => process.env.OPENCODE_API_KEY,
  },
  // OpenCode Zen free - limited-time anonymous, model jev-1.13-free, no auth header
  // (seen in hermes-jev-approvals: base_url https://opencode.ai/zen/v1/systemone, no Authorization)
  'zen-free': {
    baseUrl: 'https://opencode.ai/zen/v1/systemone',
    model: 'jev-1.13-free',
    apiKey: () => process.env.OPENCODE_API_KEY || null, // null = anonymous
  },
};

function slug(s) {
  const sl = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return (sl || 'option').slice(0, 40);
}

export async function scoreOptions({ state, question, options, provider = 'zen-free' }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider ${provider}, use ${Object.keys(PROVIDERS).join('|')}`);
  // A single option cannot be ranked, and an empty list would make Jev invent
  // criteria. Fail with a fixable message instead of sending a useless request.
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(`need at least 2 options to score, got ${Array.isArray(options) ? options.length : typeof options}`);
  }
  if (options.some((o) => typeof o !== 'string' || !o.trim())) {
    throw new Error('every option must be a non-empty string');
  }

  const criteria = {};
  for (const opt of options) criteria[slug(opt)] = opt;

  const body = {
    state: state || question,
    model: p.model,
    questions: { pick: { type: 'choice', instructions: question, criteria } },
  };

  const headers = { 'Content-Type': 'application/json' };
  const key = p.apiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  else if (provider !== 'zen-free') throw new Error(`Missing API key for provider ${provider}`);

  const res = await fetch(p.baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // Without a deadline a stalled Jev blocks the caller (MCP tool call / CLI)
    // forever. Same 10s default as the hook and the plugin; override with
    // JEV_TIMEOUT_MS.
    signal: AbortSignal.timeout(Number(process.env.JEV_TIMEOUT_MS) || 10000),
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
  if (!ans?.probabilities) throw new Error('Bad Jev response: ' + text.slice(0, 500));

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
