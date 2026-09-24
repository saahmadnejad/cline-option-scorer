// cline-plugin.js — single-file Cline plugin (tools + hooks).
// Only imports Node builtins + @cline/sdk (required by `cline plugin install`).
//
// CONTRACT (verified against @cline/core 0.0.83 / @cline/shared):
//   plugin = { name, manifest: { capabilities: ["tools", "hooks"] }, hooks, setup(api, ctx) }
//   - `setup` receives an AgentExtensionApi: api.registerTool(tool).
//   - `hooks` is AgentRuntimeHooks = { beforeRun, afterRun, beforeModel,
//     afterModel, beforeTool, afterTool, onEvent }. `beforeTool` may RETURN
//     `{ input }` to rewrite the tool input - that is what makes the
//     deterministic enrichment below possible in-process, with no shell hook.
// Zero dependencies, node >= 18.
import { createTool } from "@cline/sdk";
import { resolveConfig } from "./src/jev-config.js";

// Provider endpoints/models — everything else (keys, timeout, overrides) comes
// from cline-jev.json via resolveConfig(). No environment variables.
const PROVIDERS = {
  typesafe: { baseUrl: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  zen: { baseUrl: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" },
  "zen-free": { baseUrl: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13-free" },
};
const QUESTION_TOOLS = /^ask_(question|followup_question)$/i;

function slug(s) {
  const sl = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return (sl || "option").slice(0, 40);
}
const hasPct = (s) => /\(\d+(\.\d+)?%\)\s*$/.test(String(s));
const withPercents = (options, probabilities) =>
  options.map((o) => (hasPct(o) || probabilities[o] == null ? o : `${o} (${(probabilities[o] * 100).toFixed(1)}%)`));

async function scoreWithJev(state, question, options) {
  const cfg = resolveConfig();
  const known = PROVIDERS[cfg.provider] || PROVIDERS["zen-free"];
  const criteria = {};
  for (const opt of options) criteria[slug(opt)] = opt;
  const headers = { "Content-Type": "application/json" };
  const key = cfg.opencodeApiKey || cfg.typesafeApiKey;
  if (key) headers.Authorization = `Bearer ${key}`; // zen-free works anonymously
  const res = await fetch(cfg.baseUrl || known.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      state,
      model: cfg.model || known.model,
      questions: { pick: { type: "choice", instructions: question, criteria } },
    }),
    // A stalled Jev must never block a Cline tool call.
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jev ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Jev returned non-JSON: ${text.slice(0, 300)}`);
  }
  const ans = json.answers?.pick;
  if (!ans?.probabilities) throw new Error(`Bad Jev response: ${text.slice(0, 300)}`);
  const probabilities = {};
  for (const opt of options) probabilities[opt] = ans.probabilities[slug(opt)] ?? 0;
  // `ans.choice` is a criterion SLUG - map it back to the original label.
  const choice = options.find((o) => slug(o) === ans.choice) ?? ans.choice;
  return { choice, probabilities, confidence: ans.confidence ?? 0, model: json.model };
}

const scoreTool = createTool({
  name: "score_cline_options",
  description:
    "Score Cline question options with Jev 1.13 and return percentages. " +
    "Call this BEFORE ask_question/ask_followup_question, then append the returned " +
    "'enrichedOptions' labels (e.g. 'GitHub Actions (72.5%)') to the question you show the user. " +
    "The plugin also enriches ask_question options automatically via a beforeTool hook.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Task context (what the user is doing). Defaults to question." },
      question: { type: "string", description: "The question you will ask the user." },
      options: { type: "array", items: { type: "string" }, description: "2-5 option labels (Cline's ask_followup_question rejects more than 5)." },
    },
    required: ["question", "options"],
  },
  execute: async (input) => {
    if (typeof input?.question !== "string" || !Array.isArray(input?.options) || input.options.length < 2) {
      throw new Error("score_cline_options needs a `question` string and at least 2 `options`");
    }
    // Cline's own schema caps ask_followup_question at 5 options; catch it here
    // so the model fixes the question instead of composing one Cline rejects.
    if (input.options.length > 5) {
      throw new Error("`options` must have at most 5 labels - Cline's ask_followup_question rejects more. Merge or drop options and retry.");
    }
    const r = await scoreWithJev(input.state || input.question, input.question, input.options);
    return {
      ...r,
      enrichedOptions: withPercents(input.options, r.probabilities),
      hint: "Use enrichedOptions as the option labels in your ask_question call.",
    };
  },
});

// beforeTool hook: rewrite ask_question input with Jev percentages. Fail-open:
// any problem returns undefined, which leaves the tool call untouched.
async function enrichAskInput(context) {
  const toolName = context?.tool?.name || context?.toolCall?.name || "";
  if (!QUESTION_TOOLS.test(toolName)) return undefined;
  const input = context?.input;
  if (!input || typeof input !== "object") return undefined;
  const { question, options } = input;
  if (typeof question !== "string" || !Array.isArray(options) || options.length < 2) return undefined;
  if (!options.every((o) => typeof o === "string") || options.some(hasPct)) return undefined; // never double-tag
  const rootPath = context?.snapshot?.workspaceInfo?.rootPath;
  const state = typeof rootPath === "string" && rootPath ? `${question}\n(workspace: ${rootPath})` : question;
  try {
    const { probabilities } = await scoreWithJev(state, question, options);
    return { input: { ...input, question, options: withPercents(options, probabilities) } };
  } catch (e) {
    console.error(`[jev-percent] scoring failed, allowing as-is: ${e?.message || e}`);
    return undefined;
  }
}

const plugin = {
  name: "cline-jev-percent",
  manifest: { capabilities: ["tools", "hooks"] },
  setup(api) {
    api.registerTool(scoreTool);
  },
  hooks: {
    beforeTool: enrichAskInput,
  },
};

export default plugin;
