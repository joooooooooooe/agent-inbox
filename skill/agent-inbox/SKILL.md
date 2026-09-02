---
name: agent-inbox
description: Use when blocked on a decision, preference, approval, or piece of information only the operator can provide — product taste calls, scope choices, tradeoff rulings, naming, "which option do you want" — especially when the operator is away or the answer can wait. Also use at task start to check whether a question was already answered, before asking anything in chat.
---

# Agent Inbox

The operator runs a cross-project inbox for agent questions. It is a **file protocol** — you
participate by reading and writing files; no server or tool is required.

**The contract lives at `{{DATA_DIR}}\PROTOCOL.md`. Read it before your
first filing in a session; it is authoritative over this skill.**

## Workflow

1. **Check for existing answers first**: read `{{DATA_DIR}}\answers\<project>.md`
   (or the project's in-repo mirror, e.g. MyProject's `dev/agent-answers.md`). Never re-ask
   an answered question.
2. **File one JSON file per decision** into `{{DATA_DIR}}\requests\`,
   following PROTOCOL.md's schema exactly (id format, `status: "open"`, `answer: null`).
3. **Plain language is mandatory** in title/ask/background/options: write for a smart
   person who has never seen the codebase. Cause → effect → tradeoff → cost. File paths,
   symbols, section/decision IDs go ONLY in `technical_context`. Keep the ask to the
   question itself (1–3 short sentences); each option's effect and cost goes in that
   option's `description`, shared context in `background`.
4. **Keep working**: set `blocking: true` honestly, then continue unblocked subtasks. Use a
   clearly-labeled reversible placeholder if code needs a value before the answer arrives.
5. **Consume the answer**: re-read your request file (whole file; also check
   `requests\archive\`). If `status` is `"returned"`, read `returned_reason`, rewrite in
   plain language, set status back to `"open"`.

## Don't

- Don't decide product-taste calls yourself because the operator is away — file and proceed.
- Don't leave decisions only in repo docs, code comments, or chat — they're invisible to
  The operator's queue. (In-repo notes may *supplement* a filed request.)
- Don't ask in chat what the inbox already answered.
