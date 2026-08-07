# Agent Inbox

A local-only web app + file protocol giving Joe one at-a-glance to-do list of
questions/requests from coding agents (Claude Code, Codex, …) across disconnected projects,
with structured answers agents can consume by reading files. Zero npm dependencies, no build
step. (2026-08-07)

- **Design spec:** `docs\2026-08-07-agent-inbox-design.md`
- **Agent-facing contract:** `protocol\PROTOCOL.md` (`{{DATA_DIR}}` tokens rendered and
  synced into the data store on boot)
- **Data store:** `<home>\.agent-inbox` (e.g. `C:\Users\you\.agent-inbox`; created and
  seeded on first boot — data stays local and is never part of this repo)

## Setting up a new machine (golden path)

```
git clone https://github.com/joooooooooooe/agent-inbox     (any location works)
cd agent-inbox
node setup.js
```

`node setup.js` (zero dependencies, idempotent, safe to re-run) does three things:
1. creates and seeds the data store at `<home>\.agent-inbox`, with `PROTOCOL.md` rendered
   for this machine's paths;
2. installs the Claude skill **machine-wide** at `<home>\.claude\skills\agent-inbox\SKILL.md`
   (rendered the same way — Claude Code then picks it up in every project on the machine);
3. prints next steps.

Then register this machine's projects in `<home>\.agent-inbox\projects.json` (see
"Register a project"), paste the AGENTS.md snippet from `PROTOCOL.md` section 5 into each
Codex-driven repo (Codex doesn't read Claude skills), and run `start-inbox.cmd`.

## Run

Double-click `start-inbox.cmd`, or from the repo folder:

```
node server.js
```

Then open <http://127.0.0.1:7717>. Requires Node ≥ 20. The server binds `127.0.0.1` only.

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_INBOX_PORT` | `7717` | Listen port |
| `AGENT_INBOX_DATA_DIR` | `%USERPROFILE%\.agent-inbox` | Data store location (mainly for testing) |

## How it works

**The file protocol is the contract; the app is a viewer/editor.** Agents file requests by
writing one JSON file each into `<home>\.agent-inbox\requests\`; Joe answers in the
app; the answer is embedded back into the same JSON file, and a per-project markdown digest
is regenerated at `answers\<slug>.md` (and optionally mirrored into the project's repo). No
server needs to be running for an agent to file or read.

The UI polls every 3 seconds, so files written by agents appear on their own.

Requests must be written in **plain language** (see `protocol\PROTOCOL.md` section 1):
answerable by a non-technical reader in 60 seconds, with all jargon quarantined in the
request's `technical_context` field. The app runs an advisory clarity lint (amber badge)
and gives Joe a one-click **Return for rewrite** button that bounces a request back to its
agent (`status: "returned"` + a reason); the agent rewrites it and sets it back to `open`
("Waiting on agent" in the header counts these).

To keep things small over time: each digest holds the newest 50 entries (older history
rolls into `answers\<slug>-archive.md`, which is never mirrored), and settled requests can
be archived from the UI into `requests\archive\` without affecting digest content.

## Register a project

Hand-edit `<home>\.agent-inbox\projects.json` (example from Joe's machine):

```json
{
  "schema_version": 1,
  "projects": {
    "myproject": {
      "name": "MyProject",
      "repo": "C:\\Users\\you\\MyProject",
      "mirror": "dev\\agent-answers.md"
    }
  }
}
```

- `name` — display name in the UI.
- `repo` — absolute path to the project repo.
- `mirror` (optional) — path **relative to `repo`** where the project's answers digest is
  copied after every answer/status change, so agents find answers inside their own repo.
  Omit it for no mirroring. A missing repo or bad mirror path never breaks answering — it
  surfaces as a warning in the UI.

Requests for unregistered slugs still work; registration only adds the display name and
mirroring.

## Point agents at the inbox

Add the "Asking Joe (Agent Inbox)" snippet from `protocol\PROTOCOL.md` (section 5) to the
project's `AGENTS.md` / `CLAUDE.md`. Agents then file requests per the protocol and consume
answers from the digest (or in-repo mirror).

## Tests

From the repo folder:

```
node --test test/
```

Covers the whole store layer (create/answer/status for all five response types, answer-shape
validation, atomic writes, digests, mirroring, id sanitation, malformed-file tolerance)
against temp directories — it never touches the real data store.

## Auto-start with Task Scheduler (optional, instructions only)

1. Open **Task Scheduler** → *Create Task…*
2. **General:** name it `Agent Inbox`; select *Run only when user is logged on*.
3. **Triggers:** *New…* → *At log on* → your user.
4. **Actions:** *New…* → *Start a program*:
   - Program/script: `C:\Program Files\nodejs\node.exe`
   - Arguments: `server.js`
   - Start in: your clone folder (e.g. `C:\Users\you\AgentInbox`)
5. **Conditions:** untick *Start the task only if the computer is on AC power*.
6. OK to save. The inbox will be at <http://127.0.0.1:7717> after every logon; open it (or
   run `start-inbox.cmd`, which reuses the port and just opens the browser tab — note it
   will report the port in use if the task's server is already running, which is fine).

## API (localhost only)

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | `{ projects, requests, invalid }` — fresh read every call |
| `/api/requests` | POST | Create a request (UI "New request" and tests) |
| `/api/requests/<id>/answer` | POST | `{ value, notes?, force? }` — answer; `409` if not open unless `force: true` |
| `/api/requests/<id>/status` | POST | `{ status, superseded_by?, returned_reason? }` — reopen / withdraw / supersede / return for rewrite (`returned` requires `returned_reason`) |
| `/api/requests/<id>/archive` | POST | Move a settled (answered/withdrawn/superseded) request into `requests\archive\`; `409` otherwise |

POSTs require `Content-Type: application/json` and a `Host` header of
`127.0.0.1:<port>` or `localhost:<port>`; bodies are capped at 1 MB. No CORS.
