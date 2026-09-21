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
npx @donbee/cline-option-scorer --demo     # try it, no install, no key

npm install -g @donbee/cline-option-scorer
cline-option-scorer --demo                 # end-to-end scoring
cline-option-scorer-install-hook           # -> ~/.cline/hooks/PreToolUse.js
```

Three independent surfaces, same scoring core (`src/jev-client.js`):

| Surface | File | Use when |
|---|---|---|
| **PreToolUse hook** | `hooks/PreToolUse.js` | You want percentages even if the model never calls a tool (deterministic, automatic) |
| **Cline plugin** | `cline-plugin.js` | SDK / CLI / Kanban sessions (`score_cline_options` tool + `beforeTool` hook) |
| **MCP server** | `mcp-server.js` | VSCode extension, where SDK plugins are unsupported |

Prompt steering (`.clinerules`, `skills/jev-percentages/SKILL.md`) is a 4th,
weakest layer — the model may skip a tool call, which is exactly why the hook
exists.

## Setup

Node >= 18, no runtime dependencies. `OPENCODE_API_KEY` is optional — without
it the anonymous `jev-1.13-free` model is used.

```bash
PKG="$(npm root -g)/@donbee/cline-option-scorer"
cline plugin install "$PKG"                    # plugin tool + beforeTool hook
# MCP: add to ~/.cline/mcp.json:
#   "jev-percent": {"command":"node","args":["<PKG>/mcp-server.js"]}
```

Open a **new** Cline session afterwards — hooks and plugins load at startup.
Verify the hook with `tail -n 5 ~/.cline/data/logs/jev-hook.jsonl`
(`intercept` / `enriched` / `skip` / `fail_open`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_API_KEY` / `TYPESAFE_API_KEY` | — | Paid (`jev-1.13`) / direct TypeSafe (`jev-1.13.0`) auth |
| `JEV_BASE_URL` | `https://opencode.ai/zen/v1/systemone` | SystemOne endpoint |
| `JEV_MODEL` | `jev-1.13-free` | `jev-1.13-free` \| `jev-1.13` \| `jev-1.13.0` |
| `JEV_TIMEOUT_MS` | `10000` | Deadline per scoring call; the hook fails open after this |

## CLI

```bash
node src/cli.js --demo                                        # zen-free, no key
node src/cli.js --demo --provider zen --model jev-1.13        # needs OPENCODE_API_KEY
node src/cli.js --demo --provider typesafe                    # needs TYPESAFE_API_KEY
node src/cli.js --state "..." --question "Which CI?" --option "GitHub Actions" --option "GitLab CI"
cat ask.xml | node src/cli.js                                 # enrich real Cline XML
```

`jev-1.13*` are `decision` models — no chat, no tool calls, only SystemOne
calls. Develop with a chat model, score with Jev.

## Developing

```bash
npm run verify                       # syntax checks + 11 hermetic tests, no network
npm run install:hook                 # -> ~/.cline/hooks/PreToolUse.js (mode 755, verified)
cline plugin install /path/to/repo   # plugin tool + beforeTool hook (re-run after edits!)
```

## Publishing

Creating a **GitHub Release** is the only way this package reaches npm.
Publishing a release runs `.github/workflows/publish.yml`, which verifies and
publishes via **npm trusted publishing (OIDC)** — no `NPM_TOKEN` secret.
The tag must match `package.json` (stable → `latest`, prerelease → `next`).

```bash
npm version 0.1.1 --no-git-tag-version   # bumps package.json + package-lock.json
git commit -am "chore: release v0.1.1" && git push
gh release create v0.1.1 --generate-notes
```

One-time bootstrap: npm only lets you configure a trusted publisher on a
package that already exists ([npm/cli#8544](https://github.com/npm/cli/issues/8544)),
so the **first version must be published by hand** (`npm login && npm publish`),
then register repo `saahmadnejad/cline-option-scorer` + workflow `Publish to npm`
as trusted publisher. Re-releasing an already-published version is safe — the
workflow verifies and skips the publish instead of failing.
