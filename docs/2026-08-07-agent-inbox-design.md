# Agent Inbox — Design Spec (2026-08-07)

## Purpose

A local-only web app + file protocol that gives the operator a single at-a-glance to-do list of
questions/requests from coding agents (Claude Code, Codex, etc.) across many disconnected
projects, lets him answer them in structured form inside the app, and gives agents a
canonical, discoverable place to consume answers so they stop re-asking.

## Core principle

**The file protocol is the contract; the app is a viewer/editor.** Agents participate with
nothing but filesystem writes — no server needs to be running for an agent to file a request
or read an answer. The web app is the operator's console over the same files.

## Locations

| Thing | Path |
|---|---|
| App code (this repo) | `C:\Users\operator\AgentInbox` |
| Data store (protocol surface) | `C:\Users\operator\.agent-inbox` |

The server creates and seeds the data store on first boot if missing.

## Data store layout

```
C:\Users\operator\.agent-inbox\
  PROTOCOL.md                  # the contract agents read: how to file, how to consume answers
  projects.json                # registry: slug -> { name, repo, mirror? }
  requests\<id>.json           # one file per request; answer embedded in the same file
  requests\archive\<id>.json   # settled requests filed away (hidden from the app; still in digests)
  answers\<slug>.md            # regenerated per-project digest (newest 50 answered requests)
  answers\<slug>-archive.md    # digest overflow: everything older than the newest 50
```

- One file per request ⇒ no write contention between concurrent agents.
- `PROTOCOL.md` is authored in this repo at `protocol/PROTOCOL.md` and copied to the data
  dir on server boot if missing or older (compare file content; overwrite when different,
  since the repo copy is canonical).
- `projects.json` seeded as `{ "schema_version": 1, "projects": {} }`.

## Request file schema (schema_version 1)

Filename: `<id>.json` where `id` = `<YYYYMMDD>-<project>-<kebab-short-title>-<4 random hex>`.

```json
{
  "schema_version": 1,
  "id": "20260807-myproject-answer-storage-a1b2",
  "project": "myproject",
  "agent": "claude-code",
  "title": "Choose storage format for answers",
  "ask": "One or two sentences: the actual question/decision needed.",
  "background": [
    "Bullet strings giving enough context to decide without opening the repo."
  ],
  "urgency": "high",
  "blocking": true,
  "response": {
    "type": "choice",
    "options": [
      { "key": "md", "label": "Markdown file", "description": "optional" },
      { "key": "json", "label": "Structured JSON" }
    ]
  },
  "on_answered": [
    "Free-text notes on what the asking agent intends to do with the answer."
  ],
  "technical_context": [
    "Optional: file paths, symbols, decision/section refs, agent-to-agent notes — the jargon quarantine."
  ],
  "created": "2026-08-07T18:00:00Z",
  "status": "open",
  "answer": null,
  "superseded_by": null
}
```

Field rules:
- **Plain language is mandatory** for `title`, `ask`, `background`, and option
  labels/descriptions: no file paths, code identifiers, § references, decision/ticket IDs,
  workstream slugs, or non-English acronyms — those go in `technical_context` (optional
  string array, rendered collapsed in the UI, exempt from the clarity lint). The ask states
  the decision in cause → effect → tradeoff/cost terms; acceptance bar is the 60-second
  test (see PROTOCOL.md). Non-conforming requests are returned unanswered for rewrite.
- `urgency`: `high | medium | low`. `blocking`: boolean (agent is stopped until answered).
- `response.type`: `choice` (radio, one of `options`) | `multi_select` (checkboxes over
  `options`) | `text` (free text) | `checklist` (options rendered as a to-do checklist the operator
  ticks; answer = keys checked) | `approval` (approve / reject / approve-with-notes).
- `options[].key` required and unique within the request for option-based types.
- `status`: `open | answered | returned | withdrawn | superseded`. `returned` is the app's
  one-click "rewrite this in plain language" bounce: set only by the app (with a required
  `returned_reason` string, kept as history); the agent rewrites its file and sets status
  back to `open`. Digests exclude `returned`; only open requests can be returned.
- `answer` (set by app): `{ "value": <string | string[] | {"decision": "approve|reject", ...}>,
  "notes": "optional free text", "answered_at": "ISO" }`.
  - `choice` ⇒ value = option key (string). `multi_select`/`checklist` ⇒ string[].
    `text` ⇒ string. `approval` ⇒ `{ "decision": "approve" | "reject" }`.
- Unknown extra fields are preserved on write (read-modify-write keeps them).
- Malformed/invalid JSON files must not crash anything; they surface in the UI as an
  "invalid" row with the filename and parse error, and are skipped by digests.

## projects.json

```json
{
  "schema_version": 1,
  "projects": {
    "myproject": {
      "name": "MyProject",
      "repo": "C:\\Users\\operator\\MyProject",
      "mirror": "dev\\agent-answers.md"
    }
  }
}
```

- `mirror` (optional): path **relative to `repo`** where the app copies the project's
  answers digest after every answer/status change, so agents find answers inside their own
  repo. Absent ⇒ no mirroring. Mirror writes must never throw fatally (repo may be absent);
  failures are reported in the API response and UI as a warning.
- Requests referencing a project slug not in the registry still work (shown under their
  slug); registration only adds display name + mirroring.

## Answers digest (`answers/<slug>.md`)

Regenerated (full rewrite, atomic) after every answer/status mutation. Format:

```markdown
# Agent Inbox — answered requests for <name>

> Generated by Agent Inbox. Do not edit; edits will be overwritten.
> Machine-readable source of truth: C:\Users\operator\.agent-inbox\requests\<id>.json

## 2026-08-07 — Choose storage format for answers  (id: 20260807-myproject-...-a1b2)
- **Asked by:** claude-code — **Status:** answered
- **Ask:** ...
- **Answer:** Both markdown + JSON
- **Notes:** ...
```

Newest first. Includes `answered` and `superseded` (marked, with pointer to successor);
excludes `open`/`withdrawn`/`returned`.

Capped at the 50 most recent entries (by `answered_at || created`); everything older rolls
into `answers/<slug>-archive.md` (same format, regenerated the same way, atomically). When
the archive is non-empty the main digest ends with a footer pointing at it. Only the main
digest is mirrored into repos; the archive stays in the data store. Digest generation scans
both `requests/` and `requests/archive/`, so archiving a request never changes digest
content.

## Server (`server.js` + `lib/`)

- Node ≥ 20, **zero npm dependencies** (built-in `node:http`, `node:fs`, `node:path`,
  `node:crypto`). Binds `127.0.0.1` only, port `7717` (overridable via `AGENT_INBOX_PORT`).
- Static: serves `public/index.html` (and nothing else outside `public/`).
- API (JSON):
  - `GET /api/state` → `{ projects, requests: [...], invalid: [...] }` (reads the store
    fresh each call; no caching layer needed at this scale).
  - `POST /api/requests` → create a request (used by UI's "new request" and by tests).
  - `POST /api/requests/:id/answer` → body `{ value, notes? }`; validates value shape
    against `response.type`; sets `status: "answered"`, writes atomically
    (temp file + rename), regenerates digest, mirrors. Returns updated request +
    `mirror_warnings: []`.
  - `POST /api/requests/:id/status` → body `{ status }` for reopen (`open`), `withdrawn`,
    `superseded` (+ optional `superseded_by`), or `returned` (+ required `returned_reason`;
    only from `open`). Same digest/mirror refresh.
  - `POST /api/requests/:id/archive` → move a settled (answered/withdrawn/superseded)
    request into `requests/archive/`; 409 for any other status or if already archived.
    Digest content is unaffected. No unarchive route — move the file back manually.
  - `GET /api/state` responses include advisory `clarity_warnings: []` per request (plain-
    language lint over title/ask/background/option labels: paths, `§`, ID patterns like
    `D-103`, backticked code, ask > 400 chars; `technical_context` is exempt). Never blocks.
  - Errors: 400 malformed input, 404 unknown id, 409 answering a non-open request
    (unless `force: true`), 500 with message on IO failure. Never silently swallow.
- `lib/store.js`: pure store functions (list/read/validate/answer/setStatus/digest/mirror)
  taking the data dir as a parameter — unit-testable against a temp dir.
- ID sanitation: request ids from URLs must be validated (`^[A-Za-z0-9-]+$`) — no path
  traversal.

## UI (`public/index.html`, single file, inline CSS/JS, no build step)

Functional target per the operator's mockup (visuals free):
- Header counts: Needs You (open), Blocking, Waiting on agent (returned + unknown
  statuses), Answered Today.
- Filter tabs: All / Needs you / Blocking / Answered; search box over title/ask/project.
- Request list grouped or badged by project, sorted: blocking first, then urgency, then age.
- Detail panel: ask, background bullets, `on_answered` notes, `technical_context` collapsed
  under a `<details>` labeled "Agent-to-agent notes (technical)", clarity warnings (amber),
  response control per type (radio / checkboxes / textarea / checklist / approve-reject),
  notes field, Submit Answer, and a "Return for rewrite" button (prefilled plain-language
  reason → `status: returned`). Answered view shows the recorded answer + Reopen / Mark
  superseded / Archive buttons. Returned view shows the reason ("Returned" indicator, under
  All). Withdrawn hidden behind the All filter. List rows carry an amber "clarity" badge
  when the lint fires.
- "New request" form (for manual entries / testing the pipeline).
- Polls `GET /api/state` every 3 s; agents write files at any time.
- Respects `prefers-color-scheme` (light + dark).
- Invalid files listed in a collapsed "problems" strip.

## Protocol doc + per-project scaffolding

`protocol/PROTOCOL.md` (copied into the data store) contains:
1. The schema above with a full example.
2. Filing rules for agents: search `requests/` and the project digest **before** filing
   (don't re-ask answered questions); one decision per request; write enough background to
   decide without opening the repo; set `blocking` honestly.
3. Consumption rules: read `answers/<slug>.md` (or the in-repo mirror) at task start;
   the JSON file is the machine-readable record; `superseded` answers must not be acted on.
4. A copy-paste snippet for any project's `AGENTS.md`/`CLAUDE.md`:

```markdown
## Asking the operator (Agent Inbox)
When blocked on a decision only the operator can make, file a request as a JSON file in
`C:\Users\operator\.agent-inbox\requests\` following `C:\Users\operator\.agent-inbox\PROTOCOL.md`.
Before filing, check the answered digest (in-repo mirror if present, else
`C:\Users\operator\.agent-inbox\answers\<project>.md`) — do not re-ask answered questions.
Answers here are the operator's direction, but durable decisions must still be promoted into this
repo's own docs per its rules.
```

## MyProject integration (landing step, in the MyProject repo)

- Register `myproject` in `projects.json` with mirror `dev\agent-answers.md`.
- Add a minimal routing entry to `Assets/_Project/Docs/AGENT-BOOTSTRAP.md`: a row in the
  "Where new information goes" table — "Question or decision only the user (Creative
  Director) can resolve → Agent Inbox (`C:\Users\operator\.agent-inbox\PROTOCOL.md`); consume
  answers from `dev/agent-answers.md`" — plus one short subsection. Routing only; no
  process content (per that doc's admission rules). Answers that are durable decisions
  still go to plan Decision Logs / ADRs per the operating model.

## Launcher & ops

- `start-inbox.cmd`: `node server.js` + opens `http://127.0.0.1:7717`.
- README.md: run instructions, how to register a project, how to add the snippet, optional
  auto-start via Windows Task Scheduler (instructions only, not configured).

## Testing

- `node --test` suite over `lib/store.js` with a temp data dir: create/list/answer each
  response type, answer-shape validation failures, atomic write behavior (no partial file),
  digest content, mirror behavior incl. missing repo, invalid-JSON tolerance, id sanitation.
- Manual end-to-end (landing gate): start server → file a request by writing a JSON file
  (as an agent would) → see it appear in UI → answer it → verify request JSON updated,
  digest regenerated, MyProject mirror written.

## Non-scope (YAGNI)

No accounts/auth (localhost bind is the boundary), no cloud sync, no notifications beyond
in-app badges, no per-agent API keys, no request editing UI beyond status/answer, no
history/undo (git the data dir later if wanted), no framework/build tooling.
