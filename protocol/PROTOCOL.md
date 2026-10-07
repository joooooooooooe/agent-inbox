# Agent Inbox — File Protocol (schema_version 1)

Last updated: 2026-10-07. Canonical source: `protocol/PROTOCOL.md` in the agent-inbox repo
(rendered and synced into `{{DATA_DIR}}/PROTOCOL.md` on every server boot; the repo copy wins).

This is the contract for coding agents (Claude Code, Codex, etc.) that need a decision from
the operator — the person whose inbox this is. **The file protocol is the contract; the app
is only a viewer/editor.** You participate with nothing but filesystem reads and writes — no
server needs to be running for you to file a request or read an answer.

## Locations

| Thing | Path |
|---|---|
| Data store root | `{{DATA_DIR}}` |
| This document (in the store) | `{{DATA_DIR}}/PROTOCOL.md` |
| Requests (one JSON file each) | `{{DATA_DIR}}/requests/<id>.json` |
| Archived requests (settled, filed away) | `{{DATA_DIR}}/requests/archive/<id>.json` |
| Answered digests (per project, newest 50) | `{{DATA_DIR}}/answers/<slug>.md` |
| Digest archive (entries older than the 50) | `{{DATA_DIR}}/answers/<slug>-archive.md` |
| Project registry | `{{DATA_DIR}}/projects.json` |
| Operator submissions | `{{DATA_DIR}}/submissions/sub-<id>.json` |
| Offline agent helper | `{{DATA_DIR}}/tools/agent.js` |

Some projects also carry an **in-repo mirror** of their digest (for example
`dev/agent-answers.md` inside the project repo). The mirror is identical to
`answers/<slug>.md` (the capped main digest only — the digest archive is never mirrored);
prefer the mirror when your project has one — it is inside your own repo and needs no extra
permissions.

---

## 1. Card structure

Keep the question or operator instructions separate from supporting technical details:

- `title` identifies the decision or action.
- `ask` contains the question or requested operator action.
- `background` contains shared context, relevant consequences, and any recommendation.
- Option `label`/`description` fields identify each choice and explain its effect and cost.
- `technical_context` (optional array of strings) holds supporting engineering details:
  file paths, symbols, decision references, workstream slugs, and implementation notes.
  The app shows it collapsed.

The app's existing advisory clarity lint flags paths, `§`, ID patterns, backticked code,
and asks over ~400 characters in the main fields. These flags are advisory; the operator
can return a request with a specific `returned_reason` when it needs revision.

**Point at a section, not a document.** Any repo-relative markdown path you write becomes a
link that renders the document inside the app. Add `#<section>` and it opens at that heading:

```
docs/2026-08-16-project-tracking-design.md#the-recommendation-up-front
```

The section name is the heading's text, lowercased, punctuation dropped, spaces turned into
hyphens — the same rule GitHub uses, so the anchor you would write for GitHub already works.
Repeated headings get `-1`, `-2` in document order. A path that names a section that does not
exist still opens the document, from the top.

Prefer the precise reference. "The tradeoff is set out in
`docs/plan.md#storage-format`" costs you nothing and saves the operator hunting through a
long document for the paragraph you meant. Put supporting references in `technical_context`.

---

## 2. Request file schema

**Filename:** `<id>.json` inside `requests/`, where

```
id = <YYYYMMDD>-<project>-<kebab-short-title>-<4 random hex>
```

- `YYYYMMDD`: today's UTC date.
- `<project>`: your project slug — lowercase letters, digits, hyphens only (`^[a-z0-9-]+$`).
- `<kebab-short-title>`: the title lowercased, non-alphanumeric runs collapsed to `-`,
  trimmed, at most ~40 chars.
- `<4 random hex>`: 4 random hex chars to avoid collisions.
- The whole id must match `^[A-Za-z0-9-]+$` and be at most 200 chars. The **filename (minus
  `.json`) is the canonical id**; keep the `id` field in the body equal to it.

**Complete worked example** (`requests/20260807-myproject-full-text-toggle-a1b2.json`):

```json
{
  "schema_version": 1,
  "id": "20260807-myproject-full-text-toggle-a1b2",
  "project": "myproject",
  "agent": "claude-code",
  "title": "Add a yes/no toggle for showing the full text?",
  "ask": "Should we add a yes/no toggle to the settings so people can choose whether the full text is shown?",
  "background": [
    "Some people find long text overwhelming; others want everything visible at once.",
    "Either choice ships this week — the cost difference is small.",
    "If you don't decide, this part of the work stays stopped."
  ],
  "urgency": "high",
  "blocking": true,
  "response": {
    "type": "choice",
    "options": [
      { "key": "yes", "label": "Yes — add the toggle", "description": "small UI addition, one more setting for users to understand" },
      { "key": "no", "label": "No — always show full text", "description": "simpler, but long text may clutter the screen" }
    ]
  },
  "on_answered": [
    "Will implement the chosen behavior and note the decision in the project's own docs."
  ],
  "technical_context": [
    "S1 workstream; relates to D-103 exception, spec §3.5.",
    "Toggle would live in the settings panel component; affects the card renderer."
  ],
  "created": "2026-08-07T18:00:00Z",
  "status": "open",
  "answer": null,
  "superseded_by": null
}
```

### Field reference

| Field | Type | Written by | Rules |
|---|---|---|---|
| `schema_version` | number | agent | Always `1`. |
| `id` | string | agent | Same as the filename minus `.json`. |
| `project` | string | agent | Project slug, `^[a-z0-9-]+$`. Unregistered slugs still work (they show under the slug); registration in `projects.json` only adds a display name and mirroring. |
| `agent` | string | agent | Who is asking, e.g. `"claude-code"`, `"codex"`. |
| `title` | string | agent | Identifies the decision or action (section 1). Required. |
| `ask` | string | agent | The question or requested operator action. Required. |
| `background` | string[] | agent | Shared context, relevant consequences, and any recommendation. |
| `urgency` | string | agent | `"high"` \| `"medium"` \| `"low"`. |
| `blocking` | boolean | agent | `true` only if you are genuinely stopped until answered. Be honest. |
| `response` | object | agent | `{ "type": ..., "options": [...] }` — see response types below. Option descriptions explain each choice's effect and cost. |
| `on_answered` | string[] | agent | Free-text notes on what you intend to do with the answer. |
| `technical_context` | string[] | agent | Optional. Supporting engineering details: paths, symbols, IDs, section refs, implementation notes. Shown collapsed in the app; never linted. |
| `created` | string | agent | ISO-8601 UTC timestamp, e.g. `"2026-08-07T18:00:00Z"`. |
| `status` | string | agent sets `"open"` | `open` \| `answered` \| `returned` \| `withdrawn` \| `superseded`. Agents set `"open"` at filing and never set `answered` or `returned`. |
| `answer` | object/null | **app only** | Agents set `null` at filing and **never write this field**. |
| `returned_reason` | string | **app only** | Set when the app returns a request for rewrite; kept as history afterwards. |
| `superseded_by` | string/null | agent sets `null` | Id of the successor request, set when a request is superseded. |

Unknown extra fields are preserved by the app on every write — you may attach your own
metadata (prefix it, e.g. `x_my_agent_state`) and it will survive.

### Status lifecycle

| Status | Set by | Meaning |
|---|---|---|
| `open` | agent (at filing, and after rewriting a returned request) | Waiting for the operator. |
| `answered` | app | The operator answered; read `answer`. |
| `returned` | app | Revision requested; read and address `returned_reason`, then set back to `open`. |
| `withdrawn` | agent or app | Question is void; do not act. |
| `superseded` | agent or app | Replaced; follow `superseded_by`, never act on this one. |

Settled requests (`answered`/`withdrawn`/`superseded`) may be moved by the app into
`requests/archive/` to keep the live folder small. Digests are unaffected by archiving.

### Response types

`response.type` must be one of:

| Type | Rendered as | Needs `options`? |
|---|---|---|
| `choice` | radio buttons — pick exactly one | yes |
| `multi_select` | checkboxes — pick any number | yes |
| `text` | free-text box | no |
| `checklist` | a to-do list the operator ticks off | yes |
| `approval` | Approve / Reject buttons | no |

For option-based types (`choice`, `multi_select`, `checklist`), `response.options` is a
non-empty array of `{ "key": "...", "label": "...", "description": "..." }`.
`key` is required and must be unique within the request; `label` and `description` are
optional but a `label` is strongly recommended to identify the choice.

### Answer shapes (what the app writes when the operator answers)

When answered, the app sets `status: "answered"` and fills `answer`:

```json
"answer": {
  "value": <shape depends on response.type — see below>,
  "notes": "optional free text from the operator (omitted when empty)",
  "answered_at": "2026-08-07T19:12:03.123Z"
}
```

Exact `value` shape per response type:

| `response.type` | `answer.value` shape | Example |
|---|---|---|
| `choice` | string — one option `key` | `"yes"` |
| `multi_select` | string[] — option `key`s (may be empty) | `["md", "json"]` |
| `checklist` | string[] — the `key`s that were checked (may be empty) | `["step-1", "step-3"]` |
| `text` | string (non-empty) | `"Call it Fred."` |
| `approval` | object with `decision` | `{ "decision": "approve" }` or `{ "decision": "reject" }` |

Notes:
- "Approve with notes" is `{ "decision": "approve" }` plus `answer.notes` — there is no
  third decision value.
- `answer.value` for approval may carry extra keys; `decision` is the one you must read.
- A reopened request keeps its previous `answer` object (and any `returned_reason`) for
  history but `status` is back to `"open"` — status, not the presence of `answer`, is what
  you act on.

---

## 3. Filing rules (how to ask)

1. **Use the card structure in section 1.** Keep the question or operator action separate
   from supporting engineering details in `technical_context`.
2. **Search before you file.** Check the answered digest for your project (in-repo mirror if
   present, else `{{DATA_DIR}}/answers/<project>.md`, plus
   `answers/<project>-archive.md` for older history) AND scan
   `{{DATA_DIR}}/requests/` for open requests about the same topic. **Do not
   re-ask an answered question, and do not duplicate an open one.**
3. **One decision per request.** If you need three decisions, file three requests. Never
   bundle.
4. **Provide the context needed for the decision** in `background`, including relevant
   consequences, costs, and your recommendation if you have one.
5. **Set `blocking` honestly.** `blocking: true` means you are stopped until answered. If
   you can proceed on an assumption, file with `blocking: false` and state the assumption in
   `background`.
6. **Fill every field in the schema** (`status: "open"`, `answer: null`,
   `superseded_by: null` are yours to set at filing). Never write the `answer` or
   `returned_reason` fields.
7. **Write atomically:** write the JSON to a temp file **in the same directory** (e.g.
   `<id>.json.tmp-<random>`), then rename it to `<id>.json`. This prevents the app or other
   agents from reading a half-written file. Files that are not valid JSON are surfaced to
   The operator as problems, not answered.
8. If your question replaces an older open request of yours, file the new one, then either
   edit the old file's `status` to `"superseded"` with `superseded_by` set to the new id, or
   mention the old id so the operator can supersede it in the app.

## 4. Consumption rules (how to read answers)

1. **At task start**, check operator responses and submissions relevant to this project:
   `node "{{DATA_DIR}}/tools/agent.js" check <slug>` (optional `--topic "task words"`,
   `--request <id>` for each awaited card). This replaces routine digest reading and
   separate polling. Short previews point at individual records; open only relevant ones.
   Named requests bypass filters/paging, including archived, reopened, withdrawn, and
   superseded records. Next-check submissions bypass topic narrowing. Page through that
   section if `next_offset` is present before choosing discretionary work. Other sections
   are paged discovery, not exhaustive standing direction: search topic/history before
   re-asking. Digests and their in-repo mirrors remain searchable operator decisions.
   If the helper is unavailable, scan project-matching request/submission files and read
   relevant records. This check requires no extra plans, roadmap, or global history reads.
2. The digest is generated — **never edit it**; edits are overwritten on the next change.
3. The **JSON request file is the machine-readable record**. To poll a request you filed,
   re-read the whole file `requests/<id>.json` (falling back to
   `requests/archive/<id>.json` if it moved) and check `status`:
   - `"answered"` → act on `answer.value` (+ `answer.notes`).
   - `"open"` → not answered yet; keep waiting (or proceed if you filed non-blocking).
   - `"returned"` → **the operator requested a revision.** Read `returned_reason`,
     address the requested changes in place (or file a fresh request), then
     set `status` back to `"open"`. The operator will not see it again until you do.
   - `"withdrawn"` → the question is void; do not act, do not re-file unless things changed.
   - `"superseded"` → **do not act on this answer.** Follow `superseded_by` to the successor
     request and use that one.
4. **If you filed a request, you MUST include its ID in the next combined check**
   (at minimum when next starting a task in that project), so returns and status changes
   reach you. Owners also check at existing next-increment/handoff checkpoints. Workers
   stay within their brief and forward out-of-scope needs rather than triaging the portfolio.
5. Answers here are the operator's direction, but **durable decisions must still be promoted into
   your repo's own docs** per that repo's rules (decision logs, ADRs, etc.). The inbox is a
   channel, not an archive of record.

## 5. Copy-paste snippet for a project's `AGENTS.md` / `CLAUDE.md`

```markdown
## Operator messages (Agent Inbox)
At task start, check operator responses and submissions relevant to this project:
`node "{{DATA_DIR}}/tools/agent.js" check <project>`; add `--topic "task words"`
and `--request <id>` for awaited cards. Open only relevant named files. Owners repeat at
existing next-work/handoff checkpoints; workers stay within their assigned scope.
When blocked on a decision only the operator can make, file a request as a JSON file in
`{{DATA_DIR}}/requests/` following `{{DATA_DIR}}/PROTOCOL.md`.
Before filing, check the answered digest (in-repo mirror if present, else
`{{DATA_DIR}}/answers/<project>.md`) — do not re-ask answered questions.
Answers here are the operator's direction, but durable decisions must still be promoted into this
repo's own docs per its rules.
```

## 6. Acting on operator submissions (only when relevant)

Operator submissions are separate from question requests. They do not use `answer` and
never enter standing-answer digests. The original `message` remains unchanged; later
operator corrections and attributed agent findings append to `events`. This is intake,
not a second authoritative work plan. Implementation still follows the message's scope
and the project's ownership, review, and acceptance rules.

Priority is `next_check` (check/respond at the next checkpoint), `planned` (check and fit
into planned work), or `later` (retain for relevant planning). Response timing is separate
from delivery scheduling. A submission does not interrupt or launch an agent. Projects
with no running owner remain visibly awaiting pickup. Owners coordinate unassigned
messages; each project check includes at most three routing-only previews. Workers may
ignore those previews without global investigation.

Use `node "{{DATA_DIR}}/tools/agent.js" --help` for action commands. The helper works
offline. Never edit submission JSON directly: all conflicting UI/CLI writes use the same
exclusive short mutation lock and expected revision. Locks left by a crashed process
are reported; verify the recorded process has stopped before manual removal. Agent
claims last 30 minutes and are distinct from those short locks. Claim returns the token
and revision; renew before expiry, use the latest returned revision on the next action.
Operator replies, priority changes, reassignment, reopening, and withdrawal invalidate
stale claims. Read receipts change neither claims nor content revision.

| Status | Meaning |
|---|---|
| `submitted` | Awaiting pickup; default at creation or after an operator reply. |
| `checking` | Claimed for investigation; an expired claim can be picked up again. |
| `waiting` | Needs an operator answer; must link an open question from this project. |
| `routed` | Work has an accountable owner and reference; **not completed**. |
| `deferred` | Preserved for later with an explanation. |
| `closed` | The requested outcome is met, with evidence and material limits. |
| `withdrawn` | Operator withdrew the request; do not act. |

Records carry `schema_version: 1`, `id` (filename), `project` (`unassigned` when unknown),
`title`, original `message`, `priority`, `status`, monotonic `revision`, UTC `created` and
`updated`, `claim: null | { owner, token, expires_at }`, `events: [{ actor: operator|agent,
message, at, owner?, status? }]`, `seen_event` (presentation only), `work: null | { owner,
reference }`, and `request_ids` (linked questions). UI state omits claim tokens. Claims and
responses require the current revision; responses also require matching owner/token and
an unexpired claim. Assigning a project releases the claim for the proper project owner.

Before classifying a submission, check relevant support, plans, known limits and answers.
Return evidence, disposition, next step and uncertainty. A routed response requires
`work.owner` and `work.reference`; waiting requires an open linked Needs-you question.
An answered/withdrawn/superseded linked question makes waiting intake eligible again.
Record durable outcomes in existing project records; do not turn this into a parallel
roadmap, and do not close a delivery request merely because it was scheduled.
