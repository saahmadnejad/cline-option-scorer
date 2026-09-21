# Jev Percentages for Cline Questions

When you need to ask the user a question with options, score the options with Jev FIRST so each option shows a calibrated percentage.

## Rule

The `PreToolUse` hook appends the percentages automatically to
`ask_question` / `ask_followup_question` options, so a plain question is already
scored. To know the numbers *before* you compose the question (or when the hook
is not installed), call the tool first:

1. Call `score_cline_options` with:
   - `state`: current task context (what the user is doing, repo facts)
   - `question`: the exact question you will ask
   - `options`: the 2-8 option labels
2. Use the returned `enrichedOptions` strings (e.g. `GitHub Actions (72.5%)`) as the option labels in your ask call.
   The hook detects labels that already end in `(xx%)` and passes them through untouched, so this never double-tags.
3. Never invent percentages — only show numbers returned by the tool or the hook.

## Example

```
score_cline_options({state: "Java Maven project on GitHub", question: "Which CI/CD?", options: ["GitHub Actions","GitLab CI","Jenkins"]})
→ enrichedOptions: ["GitHub Actions (100.0%)","GitLab CI (0.0%)","Jenkins (0.0%)"]
→ ask_followup_question with those labels
```

Backend: Jev 1.13 Choice via OpenCode Zen `jev-1.13-free` (default, no key) or `jev-1.13` (`OPENCODE_API_KEY`) or direct TypeSafe (`TYPESAFE_API_KEY`).
