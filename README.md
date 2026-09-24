# cline-option-scorer

Adds a calibrated percentage to every Cline `ask_question` /
`ask_followup_question` option, using Jev 1.13 Choice `probabilities`.

```
Which CI/CD platform should we integrate?
  1) GitHub Actions (72.0%)
  2) GitLab CI (25.0%)
  3) Jenkins (3.0%)
```

```bash
npx @donbee/cline-option-scorer --question "Which CI/CD platform?" \
  --option "GitHub Actions" --option "GitLab CI" --option "Jenkins"

npm install -g @donbee/cline-option-scorer
cline-option-scorer --state "..." --question "..." --option "A" --option "B"
cline-option-scorer-install-hook           # -> ~/.cline/hooks/PreToolUse.cjs + jev-hook-lib.cjs
```

Three independent surfaces, same scoring core (`src/jev-client.js`):

| Surface | File | Use when |
|---|---|---|
| **PreToolUse + PostToolUse hooks** | `hooks/PreToolUse.cjs`, `hooks/PostToolUse.cjs` | You want percentages even if the model never calls a tool (deterministic, automatic) — plus decision history captured after each answer |
| **Cline plugin** | `cline-plugin.js` | SDK / CLI / Kanban sessions (`score_cline_options` tool + `beforeTool` hook) |
| **MCP server** | `mcp-server.js` | VSCode extension, where SDK plugins are unsupported |

Prompt steering (`.clinerules`, `skills/jev-percentages/SKILL.md`) is a 4th,
weakest layer — the model may skip a tool call, which is exactly why the hook
exists.

## Setup

Node >= 22.5, no runtime dependencies, **no environment variables**. The defaults
run anonymously on the free `jev-1.13-free` model; everything optional (provider,
keys, timeout, history, log dir) lives in a `cline-jev.json` file — see
Configuration. Per-session decision history uses the built-in `node:sqlite`
store (unflagged from Node 23.4; on older runtimes scoring still works, just
without history).

```bash
PKG="$(npm root -g)/@donbee/cline-option-scorer"
cline plugin install "$PKG"                    # plugin tool + beforeTool hook
# MCP: add to ~/.cline/mcp.json:
#   "jev-percent": {"command":"node","args":["<PKG>/mcp-server.js"]}
```

Open a **new** Cline session afterwards — hooks and plugins load at startup.
Verify the hooks with `tail -n 5 ~/.cline/data/logs/jev-hook.jsonl`
(`intercept` / `enriched` / `skip` / `fail_open` from PreToolUse, plus `answer`
and `answer_unclear` from PostToolUse).

### Multiple concurrent sessions

Decisions are stored in `<logDir>/jev-hook.db` (SQLite, WAL mode, `busy_timeout`
set), so several Cline sessions can write at once without locking each other
out. Each row is tagged with the session (an id from the hook payload, else the
parent process) and the workspace, and `historyScope` decides what feeds the
next question:

```sql
-- inspect the store
sqlite3 ~/.cline/data/logs/jev-hook.db \
  "SELECT ts, session, event, question, answer FROM events ORDER BY id DESC LIMIT 10;"
```

## Configuration

All configuration lives in one JSON file — **no shell/environment variables are
read, ever**. Create `cline-jev.json` in the first of these locations that
exists (project root beats home):

1. your project root — the nearest ancestor directory of the Cline workspace
   containing `package.json`, `.git`, or `.cline`
2. `~/.cline/cline-jev.json`
3. `~/.config/cline-jev/cline-jev.json`

```json
{
  "provider": "zen-free",
  "model": "jev-1.13-free",
  "baseUrl": "https://opencode.ai/zen/v1/systemone",
  "opencodeApiKey": "…",
  "typesafeApiKey": "…",
  "timeoutMs": 10000,
  "logDir": "/home/me/.cline/data/logs"
}
```

| Key | Default | Purpose |
|---|---|---|
| `provider` | `zen-free` | `zen-free` \| `zen` \| `typesafe` |
| `model` | provider default (`jev-1.13-free` / `jev-1.13` / `jev-1.13.0`) | Jev model id |
| `baseUrl` | provider endpoint | SystemOne endpoint |
| `opencodeApiKey` / `typesafeApiKey` | — | Paid (`jev-1.13`) / direct TypeSafe (`jev-1.13.0`) auth |
| `timeoutMs` | `10000` | Deadline per scoring call; the hook fails open after this |
| `logDir` | `~/.cline/data/logs` | Where the hooks append `jev-hook.jsonl` (audit trail + decision history) |
| `includeHistory` | `true` | Enrich `state` with recent question→answer pairs captured by the PostToolUse hook. **Note:** this sends snippets of your Cline conversation to the Jev API — set `false` to keep questions only |
| `historyTurns` | `3` | How many past decisions to include |
| `maxStateChars` | `2000` | Hard cap for the whole `state` payload |
| `historyScope` | `session` | Which decisions count as context: `session` (isolates concurrent Cline sessions), `workspace` (shares within a project), `global` (shares everything) |
| `dbPath` | `<logDir>/jev-hook.db` | Where the SQLite decision store lives |

Every key is optional — with no file at all you get the anonymous free model.
Explicit CLI flags / tool arguments always win over the file.

> **Don't have your OpenCode key handy?** If you use the `opencode` CLI, the
> same key it stores for you is in `~/.local/share/opencode/auth.json` (the
> `opencode` entry's `key` field). Copy it into `cline-jev.json` and keep the
> file private: `chmod 600 ~/.cline/cline-jev.json`.

Every `enriched` event records the **exact `state` that was sent to Jev** —
question, workspace, and the recent-decisions block — so the audit trail shows
precisely what context scored each question:

```bash
sqlite3 ~/.cline/data/logs/jev-hook.db \
  "SELECT ts, state FROM events WHERE event='enriched' ORDER BY id DESC LIMIT 1;"
```

Questions scored through the **MCP tool** are recorded in the same trail with
`source: "mcp"` — that is what lets a pre-scored question become context for the
next one (the hooks only ever see the answer):

```bash
sqlite3 ~/.cline/data/logs/jev-hook.db \
  "SELECT ts, source, question FROM events WHERE source='mcp' ORDER BY id DESC LIMIT 5;"
```

### Uninstall

```bash
rm ~/.cline/hooks/PreToolUse.cjs ~/.cline/hooks/PostToolUse.cjs ~/.cline/hooks/jev-hook-lib.cjs
rm -f ~/.cline/hooks/PreToolUse.js.bak ~/.cline/hooks/PreToolUse.js ~/.cline/hooks/jev-hook-lib.js   # older leftovers
rm -f ~/.cline/data/logs/jev-hook.db*    # decision history (omit to keep it)
```

Open a **new** Cline session afterwards. The MCP surface goes away by deleting
its `jev-percent` entry from `~/.cline/mcp.json`.

## CLI

```bash
node src/cli.js --state "..." --question "Which CI?" --option "GitHub Actions" --option "GitLab CI"
cat ask.xml | node src/cli.js                                 # enrich real Cline XML
```

`jev-1.13*` are `decision` models — no chat, no tool calls, only SystemOne
calls. Develop with a chat model, score with Jev.
