# @donbee/jev-mcp

Universal Model Context Protocol (MCP) server and CLI to score candidate options with [Jev 1.13](https://typesafe.ai) choice probabilities.

Works with any MCP-compatible AI agent or client:
- Claude Desktop
- Cursor
- Roo Code
- Zed
- Cline
- Custom agents / LLM tools

## Features

- **Standard MCP Tool**: Exposes `score_options` (with backwards-compatible `score_cline_options` alias).
- **Unconstrained Options**: `score_options` does not impose Cline-specific limits (2 or more options). The `score_cline_options` alias *does* keep Cline's 5-option cap, because `ask_followup_question` rejects more — an enrichment Cline cannot use is not a result.
- **Zero Config by Default**: Connects to the free OpenCode Zen endpoint (`jev-1.13-free`) without requiring any API keys.
- **Configurable**: Optionally configure API keys or providers (`zen-free`, `zen`, `typesafe`) via `jev.json` or `cline-jev.json`.
- **Standalone CLI**: `jev-option-scorer` for quick terminal evaluation.
- **Autonomous Auto-Answer**: Optional `autoAnswer` parameter or config setting returning an actionable directive to skip prompting.

## Installation & Running

### Using npx (no install)
```bash
npx -y @donbee/jev-mcp
```

### In Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "@donbee/jev-mcp"]
    }
  }
}
```

### In Cursor / Roo Code / Zed
Add an MCP STDIO server:
- Command: `npx`
- Args: `["-y", "@donbee/jev-mcp"]`

### CLI Usage

The package has two bins (`jev-mcp` for the stdio server and
`jev-option-scorer` for the CLI). Running `npx @donbee/jev-mcp` starts the MCP
server (it reads JSON-RPC from stdin), so name the CLI bin explicitly:

```bash
npx -y -p @donbee/jev-mcp jev-option-scorer --question "Which database?" --option "PostgreSQL" --option "SQLite" --option "Redis"
```

Or install it globally:

```bash
npm install -g @donbee/jev-mcp
jev-option-scorer --question "Which database?" --option "PostgreSQL" --option "SQLite" --option "Redis"
```

## Tools Exposed

### `score_options`
- **Arguments**:
  - `question` (string, required): The question or decision being evaluated.
  - `options` (string[], required): 2 or more option labels to score.
  - `state` (string, optional): Context or task state. Defaults to question.
  - `autoAnswer` (boolean, optional): If `true`, directs the LLM to pick Jev's top option automatically.
  - `provider` (string, optional): `"zen-free"` | `"zen"` | `"typesafe"`.

## Configuration

Zero-config by default: without any file, scoring uses the free
`jev-1.13-free` endpoint anonymously. A config file is optional.

`jev.json` or `cline-jev.json` is read from the first of these locations that
exists:

1. the nearest ancestor of the current directory containing `package.json`,
   `.git` or `.cline` (your project root)
2. `~/.config/jev/jev.json`
3. `~/.cline/cline-jev.json`
4. `~/.config/cline-jev/cline-jev.json`

Precedence per key: explicit tool/CLI argument > config file > default.

```json
{
  "provider": "zen-free",
  "model": null,
  "baseUrl": null,
  "timeoutMs": 10000,
  "autoAnswer": false,
  "opencodeApiKey": null,
  "typesafeApiKey": null
}
```

Not read by this package (Cline-surface only, ignored silently):
`includeHistory`, `historyTurns`, `maxStateChars`, `historyScope`, `logDir`,
`dbPath` — see the audit-trail note below for why.

## Audit trail

**This server writes no decision trail.** The legacy root package's
`mcp-server.js` (and the Cline plugin package) record `intercept` /
`enriched` / `fail_open` rows with `source: "mcp"` in
`~/.cline/data/logs/jev-hook.jsonl` + SQLite, which is what lets a pre-scored
question become context for the next one. This universal server is
deliberately agent-agnostic and dependency-free, so it keeps no state: nothing
here feeds a session's history, and `state` is whatever the caller passes in.

If you need trail-backed scoring, use `@donbee/cline-plugin-jev-percent` (or
the legacy `@donbee/cline-option-scorer` MCP server).

## Requirements

Node >= 18. The client (`src/jev-client.js`) is byte-identical to the Cline
package's copy and uses only `fetch` + `AbortSignal.timeout`; the Node 22.5
floor on the Cline packages comes from `node:sqlite` in the hook core, which
this package does not ship.
