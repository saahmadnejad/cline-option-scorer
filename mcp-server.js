#!/usr/bin/env node
// mcp-server.js — zero-dependency STDIO MCP server (node >= 18).
// Exposes `score_cline_options` so Cline (CLI + VSCode extension) can score
// ask_followup_question options with Jev 1.13 BEFORE asking the user.
// Transport: newline-delimited JSON-RPC 2.0 over stdio.
import { scoreOptions } from "./src/jev-client.js";

const SERVER = { name: "cline-jev-percent", version: "0.1.0" };
const PROTOCOL = "2024-11-05";

const TOOL = {
  name: "score_cline_options",
  description:
    "Score Cline question options with Jev 1.13 (Choice probabilities) and return percentages. " +
    "Call BEFORE ask_followup_question/ask_question, then use enrichedOptions labels (e.g. 'GitHub Actions (72.5%)'). " +
    "Defaults to free OpenCode Zen jev-1.13-free (no key). Set OPENCODE_API_KEY for paid jev-1.13 or TYPESAFE_API_KEY for direct.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Task context. Defaults to question." },
      question: { type: "string", description: "Question you will ask the user." },
      options: { type: "array", items: { type: "string" }, description: "2-8 option labels." },
      provider: {
        type: "string",
        enum: ["zen-free", "zen", "typesafe"],
        description: "Default zen-free (anonymous). zen needs OPENCODE_API_KEY, typesafe needs TYPESAFE_API_KEY.",
      },
    },
    required: ["question", "options"],
  },
};

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
// MCP: a tool that fails to produce a result is still a SUCCESSFUL call whose
// result carries isError - a JSON-RPC error would make the client drop the
// call instead of showing the model why scoring failed.
function sendToolText(id, text, isError = false) {
  send(id, { content: [{ type: "text", text }], isError });
}

function validate(args) {
  if (typeof args.question !== "string" || !args.question.trim()) return "`question` must be a non-empty string";
  if (!Array.isArray(args.options)) return "`options` must be an array of strings";
  if (args.options.length < 2) return "`options` needs at least 2 labels to be worth scoring";
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
    send(id, { tools: [TOOL] });
    return;
  }
  if (method === "tools/call") {
    const args = params?.arguments || {};
    // Guard the shape first: a thrown error here would otherwise be reported as
    // a transport failure instead of a fixable argument problem.
    const problem = validate(args);
    if (problem) {
      sendToolText(id, `Invalid arguments for ${TOOL.name}: ${problem}`, true);
      return;
    }
    try {
      const r = await scoreOptions({
        state: args.state || args.question,
        question: args.question,
        options: args.options,
        provider: args.provider || "zen-free",
      });
      // One label per line, JSON-quoted, so the model can copy them verbatim.
      const lines = [
        `Jev [${r.provider}/${r.model}]: ${r.choice} (${(r.confidence * 100).toFixed(0)}% conf)`,
        ...Object.entries(r.probabilities).map(([o, p]) => `${o}: ${(p * 100).toFixed(1)}%`),
        `enrichedOptions: ${JSON.stringify(Object.keys(r.probabilities).map((o) => `${o} (${(r.probabilities[o] * 100).toFixed(1)}%)`))}`,
      ];
      sendToolText(id, lines.join("\n"));
    } catch (e) {
      // isError:true, not a JSON-RPC error: the model must SEE the failure and
      // can then ask the question unenriched instead of hanging on a dropped call.
      sendToolText(id, `Jev scoring unavailable: ${String(e?.message || e)}\nAsk the question without percentages.`, true);
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `unknown method ${method}`);
}

let buf = "";
let queue = Promise.resolve();
// Serialize frames so a slow Jev call cannot interleave responses out of order,
// and never let a rejected frame kill the server (stdio MCP servers must stay up).
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
  // Flush the last frame if the client closed without a trailing newline.
  const rest = buf.trim();
  if (rest) enqueue(rest);
  queue.then(() => process.exit(0));
});
process.stdin.on("error", (e) => {
  process.stderr.write(`[mcp] stdin error: ${String(e?.message || e)}\n`);
});
