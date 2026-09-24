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
   - `options`: **2-5** option labels (Cline's own limit - it rejects more than 5)
2. Use the returned `enrichedOptions` strings (e.g. `GitHub Actions (72.5%)`) as the option labels in your ask call.
   The hook detects labels that already end in `(xx%)` and passes them through untouched, so this never double-tags.
3. Never invent percentages — only show numbers returned by the tool or the hook.

## Auto-answer mode (opt-in)

`cline-jev.json` may set `"autoAnswer": true` (default `false`). The model may
also pass `autoAnswer: true` on a single `score_cline_options` call. Either
one means: do NOT ask the user this question — the tool returns Jev's top
option along with an explicit directive to treat it as the user's answer and
continue. The directive names the exact winner, so the choice stays visible;
the trail records the decision on the `enriched` row.

The PreToolUse hook never auto-answers: it keeps appending percentages for the
user to pick. Auto-answer only ever happens where a model (or the user, on the
CLI with `--auto`) consumes the tool output.

## Ask with options, never in prose

Percentages attach to **options**. A question written as plain chat text has
nothing to score, so it gets no numbers and is not recorded as a decision.

- Always ask through `ask_followup_question` / `ask_question` with **2-5**
  concrete options. More than five fails schema validation
  (`Too big: expected array to have <=5 items → at options`) and the question
  never reaches the user.
- Even when the answer is genuinely free-form, offer 2-5 likely candidates; the
  user can always type over them.

## When the user types instead of clicking

If the user dismisses the question and answers in chat text, **no hook can see
that text**: the choice is neither scored nor added to decision history. The
audit trail records it once as `answer_dismissed`, so the gap is visible. When
that decision matters for later questions, ask it again with options.

Do not "fill in" a missing choice with an invented percentage.

## Example

```
score_cline_options({state: "Java Maven project on GitHub", question: "Which CI/CD?", options: ["GitHub Actions","GitLab CI","Jenkins"]})
→ enrichedOptions: ["GitHub Actions (100.0%)","GitLab CI (0.0%)","Jenkins (0.0%)"]
→ ask_followup_question with those labels
```

Backend: Jev 1.13 Choice via OpenCode Zen `jev-1.13-free` (default, no key) or `jev-1.13` (`OPENCODE_API_KEY`) or direct TypeSafe (`TYPESAFE_API_KEY`).
