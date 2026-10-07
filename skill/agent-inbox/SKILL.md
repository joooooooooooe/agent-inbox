---
name: agent-inbox
description: Check operator responses and submissions relevant to this project at task start and existing owner checkpoints. Also use for decisions, approvals, information, and playtests only the operator can provide.
---

# Agent Inbox

The operator's shared Inbox uses files and works with the web app closed.
At task start, **check operator responses and submissions relevant to this project**:

```text
node "{{DATA_DIR}}/tools/agent.js" check <project> --topic "your task" --request <awaited-id>
```

Omit optional `--topic` / `--request` when unnecessary; repeat `--request` for awaited
cards. Named cards bypass discovery filters, including archives and current non-answer
statuses. Next-check submissions bypass topic narrowing. Output is short previews and
named file paths; open only relevant records. `next_offset` announces more pages;
page through next-check entries before selecting discretionary work. Search by topic
before re-asking an old question; `--include-later` includes planning inputs. No global
read receipt consumes a message on behalf of other agents.

This **replaces** routine digest reading and separate polling, not adds to it. Existing
digests/mirrors (e.g. `dev/agent-answers.md`) remain searchable history. If the helper
is unavailable, scan project-matching request/submission files and read only relevant
records. The contract is `{{DATA_DIR}}\PROTOCOL.md`; read its question schema before
first filing, or section 6 / helper `--help` when first acting on a submission.

## Workflow

1. **Check once, then stay scoped.** Owners repeat at existing next-increment/handoff
   checkpoints. Workers handle their assigned answers and forward other relevant needs;
   they do not discover new portfolio work. Unassigned previews are routing-only for owners.
   A submitting operator authorizes checking/routing; implementation follows the message
   and existing ownership/scope rules. No new agent is automatically launched.
2. **File one JSON file per decision** into `{{DATA_DIR}}\requests\`,
   following PROTOCOL.md's schema exactly (id format, `status: "open"`, `answer: null`).
3. **Separate the request from supporting technical details.** Put the question or
   operator action in `ask`, shared context in `background`, and each option's effect
   and cost in its `description`. Put supporting file paths, symbols, decision references,
   and implementation notes in `technical_context`.
4. **For submissions**, claim with the helper before acting; use its revision/token for
   responses. Check original text, later operator replies, and linked answers. Report
   evidence and limits. Routing names an owner and reference, not completion. Link
   human questions through `request_ids`. Promote durable work/decisions to existing repo
   records; keep agent findings out of operator standing-answer digests.
5. **Keep working**: set `blocking: true` honestly, then continue unblocked subtasks. Use a
   clearly-labeled reversible placeholder if code needs a value before the answer arrives.
6. **Consume by current status**, not a retained old answer. Include pending request IDs
   in the next combined check. If returned, address `returned_reason` and reopen.

## Don't

- Don't decide product-taste calls yourself because the operator is away — file and proceed.
- Don't leave decisions only in repo docs, code comments, or chat — they're invisible to
  The operator's queue. (In-repo notes may *supplement* a filed request.)
- Don't ask in chat what the inbox already answered.
