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
cline-option-scorer-install-hook
```
