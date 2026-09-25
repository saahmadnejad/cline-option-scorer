#!/usr/bin/env node
// mcp-server.js — zero-dependency STDIO MCP server (node >= 18).
// Exposes `score_options` (and alias `score_cline_options` for compatibility)
// so any MCP client (Claude Desktop, Cursor, Zed, Cline, etc.) can score
// question options with Jev 1.13 BEFORE asking the user.
// Transport: newline-delimited JSON-RPC 2.0 over stdio.
import { scoreOptions, autoDecisionLine } from "./jev-client.js";
import { resolveConfig } from "./jev-config.js";

const SERVER = { name: "jev-mcp", version: "0.3.0" };
const PROTOCOL = "2024-11-05";

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    state: { type: "string", description: "Task context or system state. Defaults to question." },
    question: { type: "string", description: "Question being evaluated or asked." },
    options: { type: "array", items: { type: "string" }, description: "2 or more option labels to score." },
    autoAnswer: {
      type: "boolean",
      description: "Skip asking: pick Jev's top option and return a directive with the choice. Defaults to configured autoAnswer flag (false).",
    },
    provider: {
      type: "string",
      enum: ["zen-free", "zen", "typesafe"],
      description: "Provider endpoint. Defaults to zen-free (anonymous, no API key needed).",
    },
  },
  required: ["question", "options"],
};

const PRIMARY_TOOL = {
  name: "score_options",
  description:
    "Score candidate options with Jev 1.13 Choice probabilities and return calibrated percentages. " +
    "Use BEFORE presenting choices to the user or making a decision. " +
    "Defaults to free OpenCode Zen jev-1.13-free (no key needed). Configure keys or providers in jev.json or cline-jev.json.",
  inputSchema: TOOL_SCHEMA,
};

// Backwards-compatible alias for existing Cline configurations
const COMPAT_TOOL = {
  name: "score_cline_options",
  description: PRIMARY_TOOL.description + " (Cline compatibility alias)",
  inputSchema: TOOL_SCHEMA,
};

const TOOLS = [PRIMARY_TOOL, COMPAT_TOOL];

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
function sendToolText(id, text, isError = false) {
  send(id, { content: [{ type: "text", text }], isError });
}

// The universal `score_options` is deliberately uncapped, but the Cline alias
// keeps Cline's own schema limit: ask_followup_question rejects more than 5
// ("Too big: expected array to have <=5 items"), so a 6-option enrichment there
// is a result the model cannot use. Say so, so the model fixes the question
// instead of composing one Cline will reject outright.
const CLINE_MAX_OPTIONS = 5;

function validate(args, { cline = false } = {}) {
  if (typeof args.question !== "string" || !args.question.trim()) return "`question` must be a non-empty string";
  if (!Array.isArray(args.options)) return "`options` must be an array of strings";
  if (args.options.length < 2) return "`options` needs at least 2 labels to be worth scoring";
  if (cline && args.options.length > CLINE_MAX_OPTIONS) {
    return `\`options\` must have at most ${CLINE_MAX_OPTIONS} labels - Cline's ask_followup_question rejects more. Merge or drop options and retry.`;
  }
  if (!args.options.every((o) => typeof o === "string" && o.trim())) return "every option must be a non-empty string";
  return null;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
    return;
  }
  if (method === "notifications/initialized" || (msg.jsonrpc === "2.0" && msg.method?.startsWith("notifications/"))) return;
  if (method === "tools/list") {
    send(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const toolName = params?.name;
    if (toolName !== "score_options" && toolName !== "score_cline_options") {
      sendError(id, -32601, `unknown tool ${toolName}`);
      return;
    }
    const args = params?.arguments || {};
    const problem = validate(args, { cline: toolName === COMPAT_TOOL.name });
    if (problem) {
      sendToolText(id, `Invalid arguments for ${toolName}: ${problem}`, true);
      return;
    }
    try {
      const cfg = resolveConfig(args);
      const auto = args.autoAnswer ?? cfg.autoAnswer === true;
      const r = await scoreOptions({
        state: args.state || args.question,
        question: args.question,
        options: args.options,
        provider: args.provider || cfg.provider || "zen-free",
        model: args.model || cfg.model,
      });

      const lines = [
        `Jev [${r.provider}/${r.model}]: ${r.choice} (${(r.confidence * 100).toFixed(0)}% conf)`,
        ...Object.entries(r.probabilities).map(([o, p]) => `${o}: ${(p * 100).toFixed(1)}%`),
        `enrichedOptions: ${JSON.stringify(Object.keys(r.probabilities).map((o) => `${o} (${(r.probabilities[o] * 100).toFixed(1)}%)`))}`,
      ];
      if (auto) {
        lines.push(`DO NOT ask the user this question. ${autoDecisionLine(args.question, r)} Treat '${r.choice}' as the user's answer and continue.`);
      }
      sendToolText(id, lines.join("\n"));
    } catch (e) {
      sendToolText(id, `Jev scoring unavailable: ${String(e?.message || e)}\nProceed without percentages.`, true);
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `unknown method ${method}`);
}

let buf = "";
let queue = Promise.resolve();
const enqueue = (line) => {
  queue = queue.then(async () => {
    try {
      await handle(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`[mcp] frame failed: ${String(e?.message || e)}\n`);
    }
  });
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) enqueue(line);
  }
});
process.stdin.on("end", () => {
  const rest = buf.trim();
  if (rest) enqueue(rest);
  queue.then(() => process.exit(0));
});
process.stdin.on("error", (e) => {
  process.stderr.write(`[mcp] stdin error: ${String(e?.message || e)}\n`);
});
