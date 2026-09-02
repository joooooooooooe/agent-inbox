# Clickable markdown links in request cards

Agents routinely name a markdown file in a request card. Today that filename is inert text, so
acting on it means hunting through the project's folder tree by hand. This design makes those
references clickable: one click opens the file in Sublime Text and renders it in the browser,
with no extra keypress. (2026-08-11)

- **Depends on:** `protocol\PROTOCOL.md` (agent-facing contract), `projects.json` (repo roots)
- **Touches:** `server.js`, `public\index.html`, `protocol\PROTOCOL.md`, `skill\agent-inbox\SKILL.md`, `test\`

## Goals

1. A markdown path written by an agent in a card renders as a clickable link.
2. Clicking it opens the file in Sublime Text **and** renders it in the browser, unattended.
3. Cards stay plain-language. No markdown syntax leaks into the card text.
4. The repo keeps its zero-dependency, no-build-step character.

## Non-goals

- No markdown parser in this project. Sublime's MarkdownPreview package does the rendering.
- No markdown formatting inside cards — not bold, not lists, not `[text](path)` link syntax.
  Card text remains plain prose per `PROTOCOL.md` section 1.
- No backwards compatibility with existing request JSON. Existing cards get a separate
  migration pass (see "Migration").
- No cross-project references. A card links only into its own project's repo.

## Why not a markdown renderer

An earlier draft had the server render markdown to HTML itself. Rejected for two reasons.
It needs a hand-written parser (the repo forbids npm dependencies), and supporting
`[text](path)` in cards would invite agents to reach for markdown formatting generally,
pulling card text away from the plain language the protocol requires.

Sublime already renders markdown correctly and is already installed. Reuse it.

## Mechanism

Verified working on build 4200 before this design was written:

```
subl.exe "C:\path\to\file.md"
subl.exe --command "markdown_preview {\"target\": \"browser\", \"parser\": \"markdown\"}"
```

The first opens the file; the second renders the active view to the browser. `--command` is a
stock `subl` argument, so no Sublime plugin is required. The user has `markdown_preview` bound
to `Alt+M` already; this design invokes the same command programmatically.

## Architecture

A browser page cannot launch a local application. The inbox already runs a local Node server,
so the click routes through it:

```
card link click
  → POST /api/open { id, path }
  → server resolves path against the card's project repo root
  → validates (see "Security")
  → spawns subl twice
  → Sublime opens the file, browser renders it
```

Rejected alternatives:

- **Custom URI protocol** (`inboxmd://` registered under `HKCU\Software\Classes`). Works with
  the server stopped, but requires registry writes in `setup.js`, a helper script, and Edge
  prompts "Open Sublime Text?" on every click until dismissed permanently. Too much
  installation surface for the benefit.
- **`file://` links.** Edge blocks `file://` navigation from an `http://` page, and it would
  deliver raw markdown rather than a rendered view.

## Components

### 1. Protocol change — `protocol\PROTOCOL.md`, `skill\agent-inbox\SKILL.md`

Agents write a **repo-relative path** as ordinary prose. Not a bare filename, because bare
names force a search; not markdown syntax, because that invites formatting.

> Read `Assets/_Project/Docs/workstreams/vertical-slice/PLAN.md` before ruling.

Forward slashes and backslashes are both accepted. Absolute paths are accepted but
discouraged — they clutter the card and are validated for repo containment anyway.

### 2. Client — `public\index.html`

A `linkifyText(text, requestId)` helper splits a string on markdown-path tokens and returns an
array of DOM nodes: text nodes for the prose, anchors for the paths. It is applied to the four
rendered text fields:

| Field | Location |
|---|---|
| `ask` | `index.html:1172` |
| `background` | `bulletSection`, `index.html:1174` |
| `on_answered` | `bulletSection`, `index.html:1175` |
| `technical_context` | collapsed `<details>`, `index.html:1046-1050` |

`technical_context` stays collapsed by default. Its links work when the disclosure is opened;
they are not surfaced elsewhere.

Detection regex matches a run of path characters ending in `.md`, case-insensitive, bounded by
whitespace or common punctuation. A trailing sentence period must not be swallowed into the
path.

**The existing XSS invariant is load-bearing** (`index.html:587`: all agent-authored text flows
through `createTextNode` / `textContent`; never `innerHTML`). `linkifyText` builds anchors with
the existing `h()` helper and puts the path in a text node child. No string-concatenated HTML.

Clicking calls `preventDefault()`, POSTs to `/api/open`, and on failure writes the server's
message into the card's existing error box.

### 3. Server — `server.js`

New route `POST /api/open`, body `{ id, path }`. It sits behind the Host-header and
content-type guards already applied to POST routes at `server.js:151`.

Resolution order:

1. Load the request by `id`; read its `project`.
2. Look up `projects[project].repo` in `projects.json`. Unknown project → 404.
3. Resolve `path` against that repo root.
4. Validate (below). Failure → 400 with a human-readable reason.
5. Spawn Sublime. Failure to spawn → 500 naming the binary that was tried.

Returns `{ ok: true }` on success. The server does **not** wait for Sublime to exit.

### 4. Configuration

`AGENT_INBOX_SUBL` environment variable, defaulting to
`C:\Program Files\Sublime Text\subl.exe` (verified present). Documented in the README's
environment-override table alongside `AGENT_INBOX_PORT` and `AGENT_INBOX_DATA_DIR`. If the
binary is absent, `/api/open` returns 500 with the attempted path so the cause is obvious.

## Security

`/api/open` turns a request body into a process spawn, so validation is the control that
matters. A path is rejected unless **all** hold:

- It resolves, via `path.resolve`, to a location inside the project's repo root. The containment
  check compares against `repoRoot + path.sep` to defeat sibling-prefix escapes
  (`C:\Users\operator\MyProject-evil`).
- It ends in `.md`, case-insensitive.
- It exists and `statSync` reports a regular file.

Arguments are passed to `spawn` as an argv array, never through a shell, so paths containing
spaces or shell metacharacters cannot inject commands. The server remains bound to `127.0.0.1`.

Traversal attempts (`..\..\..\Windows\system.ini`) fail the containment check.

## Cold start

If Sublime is not already running, `--command` can fire before the application is listening,
and the preview silently does not appear. The server probes `tasklist` for
`sublime_text.exe` before opening the file, then:

- **running:** a short settle delay (~250 ms) between the two spawns;
- **not running:** poll `tasklist` every 250 ms until the process appears (ceiling ~10 s),
  then a ~750 ms settle delay before sending the command.

Polling rather than retrying the `--command` call is deliberate: `subl` gives no reliable
signal that a command was received, so a retry could open two browser tabs. Waiting for the
process to exist is observable and fires the command exactly once. If the probe budget is
exhausted the command is sent anyway — a missing preview is a better failure than none.

The verification run for this design had Sublime already open, so the cold path needs an
explicit test on a closed editor.

## Error handling

Validation happens at click time, not render time. Resolving every candidate path on each
3-second poll would mean repeated filesystem work for 135+ markdown files per project, so
links render unconditionally and a bad one reports on click. Consequence: a path can look
clickable and fail. The error message states which check failed and the resolved path tried.

## Testing

`npm test` (`node --test test/`). The spawn function is injected into the route handler so
tests never launch Sublime.

- resolves a valid repo-relative path
- rejects traversal outside the repo root
- rejects the sibling-prefix escape (`MyProject-evil`)
- rejects a non-`.md` extension
- rejects a path that does not exist
- rejects an unregistered project
- rejects a request id that does not exist
- passes arguments as argv, not through a shell
- client: `linkifyText` splits prose correctly, leaves a trailing sentence period outside the
  path, and produces anchors via `h()` rather than `innerHTML`

## Migration

Existing request JSON files in `<home>\.agent-inbox\requests\` reference markdown three ways:
bare filenames (`STATE.md`), paths relative to the wrong repo
(`docs/2026-08-07-implementation-plan.md`, which points at agent-inbox rather than MyProject),
and directories rather than files. A separate pass rewrites them to repo-relative paths.
Out of scope for this change; the feature ships working for newly filed cards.

## Card states

All cards linkify — open, answered and archived alike. They share one rendering path, so
treating them differently would be extra work for no benefit.
