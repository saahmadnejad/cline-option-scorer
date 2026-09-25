# @donbee/cline-plugin-jev-percent

Dedicated Cline integration (plugin + PreToolUse/PostToolUse hooks) that injects calibrated choice probabilities from [Jev 1.13](https://typesafe.ai) into `ask_question` and `ask_followup_question` option prompts.

## Features

- **Cline Lifecycle Hooks**: Seamlessly enriches candidate options before presenting them to the user via `PreToolUse`.
- **Decision History**: Captures answered questions via `PostToolUse` into SQLite/JSONL audit trails to inform subsequent questions.
- **Rules & Steering**: Drops `.clinerules` and skill definition ensuring Cline restricts options to 2-5 items.
- **Auto-Answer**: Supports `autoAnswer` via `cline-jev.json` for autonomous workflow execution.

## Installation

```bash
npm install -g @donbee/cline-plugin-jev-percent
jev-cline-install-hook            # -> ~/.cline/hooks/{PreToolUse,PostToolUse,jev-hook-lib}.cjs
```

The Cline plugin itself is installed by Cline, with the SDK present:

```bash
cline plugin install "$(npm root -g)/@donbee/cline-plugin-jev-percent"
```

The bins are prefixed `jev-` on purpose: the legacy root package
(`@donbee/cline-option-scorer`) already owns the unprefixed
`cline-option-scorer` / `cline-option-scorer-install-hook`, and two global
installs would otherwise shadow each other silently.

Score options from a terminal:

```bash
jev-cline-option-scorer --question "Which database?" --option "PostgreSQL" --option "SQLite"
```

## Publishing

Released from this repo with the legacy root package on one shared version line;
a GitHub Release (`vX.Y.Z`) publishes all three. The first version of this
package was published by hand, because npm cannot create a package through
trusted publishing (OIDC) — from then on, releases are fully automated.
