# cline-option-scorer — Jev 1.13 percentages on Cline questions

`npm install -g @donbee/cline-option-scorer`

Adds a calibrated percentage to every Cline `ask_question` / `ask_followup_question`
option, using Jev 1.13 Choice `probabilities`.

```
Which CI/CD platform should we integrate?
  1) GitHub Actions (72.0%)
  2) GitLab CI (25.0%)
  3) Jenkins (3.0%)
```

Three independent surfaces, same scoring core (`src/jev-client.js`):

| # | Surface | How it runs | When to use |
|---|---------|-------------|-------------|
| 1 | **PreToolUse hook** `hooks/PreToolUse.js` | Cline runs the file, hook returns `overrideInput` | Deterministic: percentages appear even if the model never mentions Jev |
| 2 | **Cline plugin** `cline-plugin.js` | in-process plugin, `beforeTool` hook + `score_cline_options` tool | SDK / CLI / Kanban sessions |
| 3 | **MCP server** `mcp-server.js` | zero-dep STDIO JSON-RPC server | VSCode extension, where SDK plugins are not supported |

Prompt steering (`skills/jev-percentages/SKILL.md`, `.clinerules`) is the 4th,
weakest layer — the model may skip a tool call, which is exactly why the hook exists.

## Install from npm (node >= 18, no runtime dependencies)

```bash
npx @donbee/cline-option-scorer --demo     # try it, no install, no key

npm install -g @donbee/cline-option-scorer # adds the commands below to PATH
cline-option-scorer --demo                 # end-to-end scoring

cline-option-scorer-install-hook           # -> ~/.cline/hooks/PreToolUse.js (mode 755, verified)
```

The package is **scoped**, the commands are not: installing puts
`cline-option-scorer`, `cline-jev-mcp` and `cline-option-scorer-install-hook` on
PATH. `cline-option-scorer-install-hook` copies the hook to `~/.cline/hooks/`, so
the install location of the package does not matter. For the plugin and MCP
surfaces you need the installed directory — resolve it once with:

```bash
PKG="$(npm root -g)/@donbee/cline-option-scorer"
cline plugin install "$PKG"                    # score_cline_options tool + beforeTool hook

# MCP: add to ~/.cline/mcp.json
#   "jev-percent": {"command":"node","args":["<the -g path>/@donbee/cline-option-scorer/mcp-server.js"]}
```

Open a **new** Cline session after installing the hook; hooks are discovered at
startup. Verify with:

```bash
tail -n 5 ~/.cline/data/logs/jev-hook.jsonl      # intercept / enriched / skip / fail_open
```

## Install from a checkout (contributors)

```bash
node --version                       # >= 18 (uses global fetch + AbortSignal.timeout)
npm run verify                       # syntax checks + 11 hermetic tests, no network needed

npm run install:hook                 # -> ~/.cline/hooks/PreToolUse.js (mode 755, verified)
cline plugin install /path/to/repo   # plugin tool + beforeTool hook (re-run after edits!)

# MCP: add to ~/.cline/mcp.json
#   "jev-percent": {"command":"node","args":["/path/to/repo/mcp-server.js"]}
```


## How the hook receives tool input (this is the tricky part)

Verified against Cline 3.0.62 (`@cline/core`): the payload written to stdin is

```json
{
  "hookName": "tool_call",
  "tool_call":  { "id": "...", "name": "ask_question", "input": { "question": "...", "options": ["A","B"] } },
  "preToolUse": { "toolName": "ask_question", "parameters": { "question": "...", "options": "[\"A\",\"B\"]" } },
  "workspaceRoots": ["/path/to/repo"]
}
```

`preToolUse.parameters` is **flattened**: every non-string value is
`JSON.stringify()`d, so `options` arrives as a **string**, not an array.
The hook therefore prefers the unflattened `tool_call.input` and falls back to
JSON-decoding `parameters`. Reading only `preToolUse.parameters` and calling
`Array.isArray(options)` silently returns `{}` — the bug this repo shipped with.

The hook returns `{"cancel": false, "overrideInput": {...}}`; Cline replaces the
tool input with `overrideInput` before executing the call.

Cline discovers hook files by scanning the hooks search path for files whose
**basename is a hook event name** (`PreToolUse.js` → `tool_call`) and whose
extension is one of `"" .sh .bash .zsh .js .mjs .cjs .ts .mts .cts .py .ps1`.
Every match runs, so remove stray `pretooluse.*` siblings if options get
scored twice (`scripts/install-hook.mjs` warns about them).

## Fail-open contract (safety)

Every layer degrades to "ask the question as-is" instead of blocking Cline:

| Situation | Behaviour |
|---|---|
| non-question tool (`execute_command`, …) | `{}` passthrough, Jev is never called |
| options already contain `(xx%)` | `{}` passthrough — idempotent, never double-tagged |
| fewer than 2 options / odd shape | `{}` passthrough |
| Jev 4xx/5xx, timeout (`JEV_TIMEOUT_MS`, default 10s), DNS failure | `{}` + stderr note + `fail_open` log line |
| unparsable stdin, unknown option slugs | `{}` / `0.0%` — never `NaN`, never a hang |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `JEV_BASE_URL` | `https://opencode.ai/zen/v1/systemone` | any SystemOne-compatible endpoint |
| `JEV_MODEL` | `jev-1.13-free` | `jev-1.13-free` \| `jev-1.13` \| `jev-1.13.0` |
| `JEV_TIMEOUT_MS` | `10000` | deadline per scoring call |
| `OPENCODE_API_KEY` | – | Zen paid `jev-1.13`; `zen-free` works anonymously |
| `TYPESAFE_API_KEY` | – | direct `https://api.typesafe.ai/v1/systemone` (always required there) |
| `CLINE_HOOKS_DIR` | `~/.cline/hooks` | install target for `npm run install:hook` |
| `CLINE_HOOK_LOG_DIR` | `~/.cline/data/logs` | where `jev-hook.jsonl` is appended (tests point this at a tmpdir) |

API shape (identical everywhere):

```
POST { state, model, questions: { pick: { type: "choice", instructions: <question>, criteria: { <slug>: <label> } } } }
->   answers.pick.probabilities[<slug>] * 100  = percentage
     answers.pick.choice is a SLUG (not a label) and must be mapped back through `criteria`
```

## Publishing (release-triggered, no secrets)

Creating a **GitHub Release** is the only way this package reaches npm.
Publishing a release runs `.github/workflows/publish.yml`, which publishes via
**npm trusted publishing (OIDC)** — there is deliberately no `NPM_TOKEN` secret
anywhere. The tag must match `package.json`:

```bash
# example: releasing v0.1.0
npm version 0.1.0 --no-git-tag-version   # bumps package.json + package-lock.json
git add package.json package-lock.json && git commit -m "chore: release v0.1.0" && git push
gh release create v0.1.0 --generate-notes   # or click "Draft a new release" on GitHub
# -> the workflow verifies, and `npm publish`es stable versions as `latest`,
#    prerelease versions (e.g. 0.2.0-beta.1) as `next`
```

Two one-time setup items (both outside this repo):

1. **npm trusted publisher**: at
   [npmjs.com](https://www.npmjs.com/settings/donbee/packages) → the package →
   *Trusted Publisher* → add `saahmadnejad/cline-option-scorer` with the
   `Publish to npm` workflow. Until then, publishes fail with a 403.
2. **First version must be published manually** (npm can't attest OIDC for a
   package that doesn't exist yet):

   ```bash
   npm login
   npm publish   # `prepublishOnly` re-runs `npm run verify` first
   ```

   Because npm requires the package to exist before you can configure its
   trusted publisher, the **first version must be published manually** (OIDC
   attestation is impossible for a package that doesn't exist yet — see
   [npm/cli#8544](https://github.com/npm/cli/issues/8544), still open).

   > ⚠️ **Bootstrap sequence — don't let versions collide.** Pick one path:
   >
   > - **A. Manual publish IS the first release.** Publish `0.1.0` by hand,
   >   register the trusted publisher, then release `0.1.0` on GitHub. The
   >   workflow verifies the tarball and *skips* the publish (version already
   >   on npm) — green build, no duplicate. Bump to `0.1.1`+ for the next
   >   release.
   > - **B. Bump before the first release.** After the manual publish of
   >   `0.1.0`, bump to `0.1.1` *first*, then create the `v0.1.1` release so
   >   the workflow performs the real first OIDC publish.
   >
   > Either way, never re-release a version number that is already on npm —
   > the tag check passes (tag matches `package.json`) and only the idempotency
   > step saves you from a red build.

Manual publish (emergencies only — same command the workflow runs):

```bash
npm login                              # once per machine (donbee)
npm run verify                         # syntax checks + hermetic tests
npm pack --dry-run                     # inspect the tarball BEFORE publishing
npm publish                            # `prepublishOnly` re-runs `npm run verify` first
```

`publishConfig.access` is `public`: required for scoped packages, otherwise npm
publishes them as restricted (needs a paid plan) instead of free public.
Scoped packages are published as `@donbee/cline-option-scorer`; the `bin` names
stay short, so users still type `cline-option-scorer`.

After publishing, verify from a clean shell:

```bash
npm view @donbee/cline-option-scorer version
npx @donbee/cline-option-scorer --demo
```

The tarball is limited by the `files` whitelist in `package.json`: it ships
`src/{cli,jev-client,cline-interceptor}.js`, `hooks/`, `scripts/`, `skills/`,
`mcp-server.js`, `cline-plugin.js`, `README.md`, `.clinerules`.
The legacy Java prototype (`src/main/java/`, `pom.xml`, `target/`) is deliberately
**excluded** — `!src/main` in `files` keeps `npm publish` from picking it up.

---

## Repository layout

```
hooks/PreToolUse.js        Cline hook: rewrite ask_question input (deterministic)
cline-plugin.js            Cline plugin: score_cline_options tool + beforeTool hook
mcp-server.js              STDIO MCP server: score_cline_options (VSCode extension)
src/jev-client.js          scoring core: providers, slug mapping, 10s deadline
src/cline-interceptor.js   <ask_followup_question> XML parse + re-emit with percents
src/cli.js                 CLI: --demo, --state/--question/--option, --cline-xml
scripts/install-hook.mjs   installs + verifies the hook, warns about duplicate hooks
skills/, .clinerules       model steering
tests/hook.test.mjs        hermetic hook tests (local HTTP stub, real Cline payloads)
src/main/java/, pom.xml    legacy Java prototype (kept, not on the runtime path)
```

## CLI

```bash
node src/cli.js --demo                                        # zen-free, no key
node src/cli.js --demo --provider zen --model jev-1.13        # needs OPENCODE_API_KEY
node src/cli.js --demo --provider typesafe                    # needs TYPESAFE_API_KEY
node src/cli.js --state "..." --question "Which CI?" --option "GitHub Actions" --option "GitLab CI"
cat ask.xml | node src/cli.js                                 # enrich real Cline XML
```

Note: `jev-1.13*` are `decision` models — no chat, no tool calls, only SystemOne
calls. Use a chat model to develop and Jev to score.
