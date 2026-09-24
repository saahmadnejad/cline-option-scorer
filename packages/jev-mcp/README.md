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
- **Unconstrained Options**: Does not impose Cline-specific 5-option limits (allows 2 or more options).
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
```bash
npx @donbee/jev-mcp --question "Which database?" --option "PostgreSQL" --option "SQLite" --option "Redis"
```

## Tools Exposed

### `score_options`
- **Arguments**:
  - `question` (string, required): The question or decision being evaluated.
  - `options` (string[], required): 2 or more option labels to score.
  - `state` (string, optional): Context or task state. Defaults to question.
  - `autoAnswer` (boolean, optional): If `true`, directs the LLM to pick Jev's top option automatically.
  - `provider` (string, optional): `"zen-free"` | `"zen"` | `"typesafe"`.
