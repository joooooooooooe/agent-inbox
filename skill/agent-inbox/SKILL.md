---
name: agent-inbox
description: Reads and writes the operator's Agent Inbox, a local file-based queue of cards that carry questions to the operator and messages from them. Use at task start and at handoff checkpoints to check for operator replies and new cards, and whenever blocked on a decision, approval, information, or playtest only the operator can provide.
compatibility: Requires Node 20 or newer and local read/write access to {{DATA_DIR}}.
---

# Agent Inbox

The Inbox is a folder of cards and works with the web app closed. Cards you file ask the
operator something; cards from the operator bring you a message to check, route, or act on.

At task start, check the cards relevant to this project:

```text
node "{{DATA_DIR}}/tools/agent.js" check <project> --topic "your task" --request <card-id>
```

Add `--topic` to narrow the check to your task, and one `--request` for each card you are
waiting on. The output is short previews with file paths; open only the relevant cards. If a
section shows `next_offset`, page through the next-check cards before choosing other work.
Check by topic before filing a card that may already be answered; `--include-later` adds
cards the operator kept for later planning.

This one check replaces reading answer digests and polling separately. Digests and in-repo
mirrors stay searchable history. If the helper is unavailable, scan this project's card files
under `{{DATA_DIR}}/requests/` and `{{DATA_DIR}}/submissions/` and read only the relevant ones.
The contract is `{{DATA_DIR}}/PROTOCOL.md`: read its card structure, schema, and filing rules
(sections 1–3) before filing your first card, and section 6 or `agent.js --help` before acting on a card from the operator.

## Workflow

1. **Check once, then stay scoped.** Owners check again at existing handoff and next-work
   checkpoints. Workers handle cards for their assigned work and pass other relevant needs to
   their owner; they do not look for new work. Unassigned card previews are for owners to
   route. A card from the operator authorizes checking and routing; implementation follows
   the card's message and the project's existing ownership and scope rules. Nothing launches
   an agent automatically.
2. **File one card per decision**: one JSON file in `{{DATA_DIR}}/requests/`, following
   PROTOCOL.md's schema exactly (id format, `status: "open"`, `answer: null`).
3. **Keep the card readable.** Put the question or operator action in `ask`, shared context
   in `background`, and each option's effect and cost in its `description`. Put file paths,
   symbols, decision references, and implementation notes in `technical_context`.
4. **Claim a card from the operator before acting on it**, with the helper; use the revision
   and token it returns for your response. Read the original message, later operator
   replies, and linked answers. Report evidence and limits. Routing names an owner and a
   reference; it is not completion. Link any card you file about it through `request_ids`.
   Record durable work and decisions in the repo's existing records, and keep agent findings
   out of the operator's answer digests.
5. **Keep working.** Set `blocking: true` only if you are truly stopped, and continue
   unblocked subtasks. If code needs a value before the answer arrives, use a clearly
   labeled, reversible placeholder.
6. **Act on a card's current status**, not on an old answer it once had. Pass the ids of cards
   you are waiting on to the next check. If a card comes back returned, address
   `returned_reason` and reopen it.

## Don't

- Don't make product-taste calls yourself because the operator is away. File a card and
  carry on.
- Don't leave decisions only in repo docs, code comments, or chat; the operator never sees
  them there. In-repo notes may supplement a card.
- Don't ask in chat what a card has already answered.
