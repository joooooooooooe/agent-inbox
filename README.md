# Agent Inbox

[![Tests](https://github.com/joooooooooooe/agent-inbox/actions/workflows/test.yml/badge.svg)](https://github.com/joooooooooooe/agent-inbox/actions/workflows/test.yml)

**One place for agents to ask you—and for you to send questions and ideas back.**

We work on multiple projects, at varying stages of development, and often our agents
need to ask us to review, approve, test, or just be aware of something. Agent Inbox
captures it all in one place, with clear next steps.

![The inbox: questions from agents and messages to agents across projects, with an agent's reply open](docs/images/inbox.png)

## Overview

When you have several coding agents working across several repositories, they often hit
decisions only you can make. Today each one asks in its own session, and the question is
only visible while you're looking at it. The problem multiplies when you're using
different model providers with their own apps, harnesses, and workflows. 
An agent that stops on a question you never saw is an agent doing nothing for an hour.

Agent Inbox gives them one place to ask and you one place to answer. Agents file questions as
JSON files; you answer them in a local web app; the answers are written back where the agents
will look for them. Nothing leaves your machine.

Works with any coding agent that runs on your machine and can run shell commands. 
Built-in setup for Claude Code and Codex. Others need a short snippet in AGENTS.md 
or their own instructions file.

Use **Send to agents** to capture a message without deciding whether it is a bug, an
existing feature, or future work. Choose a project (or **Not sure**) and one of three
priorities: **Address Now**, **Fit into planned work**, or **Keep for later**.
The app does not launch or interrupt an agent. An eligible owner picks it up at an
existing Inbox checkpoint, checks what exists/plans, and replies with findings and
where any work belongs. Priority controls the response checkpoint, not a delivery promise.

**Needs you** retains agent questions. **For agents** shows your intake and questions
returned for rewriting. **Updates** shows unread agent responses; **History** holds
resolved items. You can reply, change priority/project, withdraw, or reopen. Original
messages are preserved. A linked plan is labelled as scheduled work, not completed work.

While the inbox page is open, a soft two-note chime announces new agent questions
and replies across all projects. Click **Enable sound** once after opening the page
(browsers need a click before playing audio), use **Test sound** to preview it, and
click **Sound on** to mute. The sound preference is remembered in this browser.
Existing messages on page load, your own messages, and read/status changes stay
quiet; multiple arrivals in one refresh play one chime. The page must stay open;
background browser throttling can delay a chime.

Agent startup remains one check, not a new reading path:

```text
node "<data-dir>/tools/agent.js" check <project> --topic "your task" --request <awaited-id>
```

The optional topic narrows discovery; explicit awaited cards and next-check submissions
remain visible. Results are bounded previews with file paths and explicit pagination.
Open only relevant records. Unassigned intake appears as at most three routing-only
previews for owners; bounded workers do not investigate other projects. No global
"consumed" flag hides a message from a later agent. `--help` explains action commands
when needed. Existing answer digests remain searchable history, not mandatory startup
reading. The helper and file protocol work with the server closed.

## Try it

```bash
node demo.js
```

That seeds a throwaway inbox with sample questions, starts the server, and opens it. Your own
data is untouched, and the temporary store is deleted when you stop it with Ctrl+C. No install
step, no dependencies — the whole project is Node's standard library and one HTML file.

Requires Node 20 or newer. A few things worth trying once it opens:

- **Send a message to agents**, then find it under **For agents**.
- **Open Updates** to read the sample agent response, and mark it read.
- **Answer the top question** and watch it leave **Needs you** and land in **Answered**.
- **Open "S1 blocked on D-103 exception scope."** It is written in agent jargon, so it
  carries the app's advisory `CLARITY` badge. **Return for rewrite** bounces it back to the
  agent with your reason.
- **After answering anything, look at `answers/orchard.md`** in the store the demo names on
  startup. That generated file is what the agent reads to learn what you decided.

## The idea

**The file protocol is the contract; the app is only a viewer.**

An agent participates using nothing but the filesystem. To ask, it writes one JSON file into
`~/.agent-inbox/requests/`. To find out what you said, it reads that file again, or reads the
generated per-project digest at `~/.agent-inbox/answers/<project>.md`. The server does not
need to be running for either. Nothing has to be installed in the agent's environment, and
agents that know nothing about each other can all use it.

That constraint is what makes it work across tools. Claude Code, Codex, and anything else that
can write a file are all first-class, because writing a file is the entire integration.

```
~/.agent-inbox/
  PROTOCOL.md            the contract agents read
  projects.json          registry: slug -> { name, repo, mirror? }
  requests/<id>.json     one file per question; the answer is written into the same file
  submissions/sub-<id>.json  operator intake, claims, attributed replies, linked work
  answers/<slug>.md      generated digest of settled questions, per project
  tools/agent.js         installed offline combined check and claim/response helper
```

### Keep instructions and technical details separate

Put the question or operator action in `ask`, shared context in `background`, and each
option's effect and cost in its `description`. Supporting file paths, symbols, decision
references, and implementation notes go in `technical_context`, which the app keeps collapsed.

The app's existing clarity checks are advisory. You can return a request to its author with
a specific reason; the agent addresses that feedback and reopens it.

### Reading what a question refers to

When a question mentions a markdown file in its project's repository, the app turns it into a
link and renders the document in place. Useful when the answer depends on a design doc you
half-remember.

An agent can point at a section rather than a whole document —
`docs/plan.md#storage-format` opens it at that heading, using GitHub's slug rule so the
anchor an agent would write for GitHub already works. Hovering any heading in a rendered
document gives you a link back to that section, which is the reference to paste into the
next request.

![A design document rendered inside the inbox](docs/images/document.png)

Rendering is a small parser in [`public/markdown.js`](public/markdown.js) with no
dependencies.

## Install it for real

```bash
git clone https://github.com/joooooooooooe/agent-inbox
cd agent-inbox
node setup.js
```

`setup.js` is idempotent and safe to re-run. It creates the data store at `~/.agent-inbox`,
writes `PROTOCOL.md` with this machine's paths, installs the offline helper and skills at
`~/.claude/skills/agent-inbox/` and `~/.agents/skills/agent-inbox/` for Claude and Codex.

Then start it:

```bash
npm start
```

and open <http://127.0.0.1:7717>. On Windows, `start-inbox.cmd` starts the server and opens the
browser in one step; on macOS and Linux, `./start-inbox.sh` does the same.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_INBOX_PORT` | `7717` | Listen port |
| `AGENT_INBOX_DATA_DIR` | `~/.agent-inbox` | Where the data store lives |

### Register your projects

Edit `~/.agent-inbox/projects.json`:

```json
{
  "schema_version": 1,
  "projects": {
    "myproject": {
      "name": "MyProject",
      "repo": "/home/you/code/myproject",
      "mirror": "dev/agent-answers.md"
    }
  }
}
```

`name` is the display name. `repo` is where the project lives, which is what lets the app
resolve documents a question links to. `mirror` is optional: a path inside the repo where the
answers digest is copied after every answer, so agents find decisions without leaving their own
working directory. A missing repo or a bad mirror path never breaks answering — it shows up as
a warning.

Questions from unregistered projects still work; registering only adds the display name,
mirroring, and document links.

Set an optional top-level `"default_project": "myproject"` in this registry to choose
the initial project in Send to agents. Display names come from each project's `name`.

### Point your agents at it

Your agents pick up the skill automatically after `setup.js`: Claude Code and Codex both
discover it. For any other agent, paste the snippet in section 5 of
`~/.agent-inbox/PROTOCOL.md` into the repo's `AGENTS.md` or its own instructions file.

## Security

It is a local web server that reads and writes files, so the boundaries are worth stating:

- **Binds `127.0.0.1` only**, and every `/api/` route — reads included — requires a `Host`
  header of `127.0.0.1:<port>` or `localhost:<port>`. Binding loopback alone would not be
  enough: DNS rebinding can make a hostile page same-origin with the inbox, and the `Host`
  check is what a browser will not let that page forge. No CORS headers are ever sent.
- **Documents are resolved inside the requesting project's own repository**, must be markdown,
  must already exist, and are size-capped. A path that escapes the repo is refused, including
  the case of a sibling directory whose name merely starts with the repo's name.
- **Text is inserted as text.** Agent-authored fields and document contents alike become DOM
  text nodes, and the markdown parser emits data rather than markup, so a document cannot
  introduce script.
- Request bodies are capped at 1 MB, request ids are validated before any filesystem access,
  and every write is atomic (write to a temporary file, then rename).

## Tests

```bash
npm test
```

No dependencies, no runner to install — `node --test` over `test/`. The suite covers:

- the store layer and the HTTP layer (host gate, content-type gate, body cap, traversal gate,
  routes);
- messages to agents: claims and their expiry, revision checks, read receipts, routing rules,
  and two separate processes racing to claim the same message;
- the agent check: project and topic filtering, paging, and cards an agent is waiting on;
- the new-arrival chime: what plays a sound, what stays quiet, and what happens when audio or
  browser storage is unavailable;
- `setup.js`, the document resolver, and the markdown parser.

Everything runs against temporary directories and never touches your real data store.
[GitHub Actions](.github/workflows/test.yml) runs the suite on Windows, macOS, and Linux for
every push.

## Auto-start on login (optional)

<details>
<summary>Windows — Task Scheduler</summary>

1. **Task Scheduler** → *Create Task…*
2. **General:** name it `Agent Inbox`; select *Run only when user is logged on*.
3. **Triggers:** *New…* → *At log on* → your user.
4. **Actions:** *New…* → *Start a program*:
   - Program/script: `C:\Program Files\nodejs\node.exe`
   - Arguments: `server.js`
   - Start in: your clone folder
5. **Conditions:** untick *Start the task only if the computer is on AC power*.

</details>

<details>
<summary>macOS — launchd, or Linux — systemd</summary>

On macOS, a `~/Library/LaunchAgents/agent-inbox.plist` running
`/usr/local/bin/node /path/to/agent-inbox/server.js` with `RunAtLoad`. On Linux, a systemd user
unit doing the same with `WantedBy=default.target`.

</details>

## HTTP API

Localhost only. POSTs require `Content-Type: application/json`.

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | `{ projects, requests, submissions, invalid }` — read fresh from disk every call |
| `/api/submissions` | POST | `{ project?, message, title?, priority? }` — operator intake |
| `/api/submissions/<id>/operator` | POST | `{ expected_revision, action, ... }` — reply, priority, project, withdraw, reopen |
| `/api/submissions/<id>/read` | POST | `{ through }` — mark displayed events read, without changing claim/revision |
| `/api/check` | POST | `{ project, topic?, requests?, offset?, limit?, since? }` — same compact combined project check |
| `/api/requests` | POST | Create a question |
| `/api/requests/<id>/answer` | POST | `{ value, notes?, force? }` — answer it; `409` if already settled unless `force` |
| `/api/requests/<id>/status` | POST | `{ status, superseded_by?, returned_reason? }` — reopen, withdraw, supersede, or return for rewrite |
| `/api/requests/<id>/archive` | POST | File a settled question away |
| `/api/file` | POST | `{ id, path }` — read a markdown document from that question's repo |

Submission writes from the UI and agent helper share an exclusive filesystem mutation
lock. Agent claims expire after 30 minutes; response writes require the current revision
and claim owner/token. Operator corrections invalidate stale claims, while read receipts
do not. Agent responses never enter the operator's standing-answer digests. If a process
crashes during a short mutation, the leftover lock is reported rather than automatically
stolen. Check its recorded process before removing it. Existing question files keep their
v1 schema; there is no migration of answers or question history.

## How this was built

Every line of this was written by Claude, working from a spec it wrote and a plan a second
agent produced from that spec. Both are in `docs/`, unedited, alongside the design arguments
for later changes:

- [`docs/2026-08-07-agent-inbox-design.md`](docs/2026-08-07-agent-inbox-design.md) — the
  original design spec
- [`docs/2026-08-07-implementation-plan.md`](docs/2026-08-07-implementation-plan.md) — the
  implementation plan, handed verbatim to the builder
- [`docs/2026-08-16-project-tracking-design.md`](docs/2026-08-16-project-tracking-design.md) —
  a proposal to extend the inbox into project tracking, which argues *against* the shape it was
  asked for and recommends a different one

The third is the most interesting, and the reason the inbox exists: the question of whether to
merge tracked work into the questions list is exactly the kind of decision that needs a human,
and exactly the kind that gets lost in a terminal.

## License

MIT — see [LICENSE](LICENSE).
