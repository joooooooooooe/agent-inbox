# Agent Inbox — Implementation Plan (2026-08-07)

Produced by the Plan agent from `docs/2026-08-07-agent-inbox-design.md`; handed verbatim to the builder.

Spec: `C:\Users\operator\AgentInbox\docs\2026-08-07-agent-inbox-design.md`
Repo: `C:\Users\operator\AgentInbox` — Data store: `C:\Users\operator\.agent-inbox` (created/seeded on boot, never assumed to exist).
Hard constraints: zero npm dependencies (`node:http`, `node:fs`, `node:path`, `node:crypto`, `node:test` only), no build step, single-file UI, CommonJS `.js` files (no `package.json` required; `node --test` and `node server.js` work bare — optionally add a dep-free `package.json` with `start`/`test` scripts, but it is not in the required tree).

## 1. File tree

```
C:\Users\operator\AgentInbox\
  server.js              # HTTP server: static + JSON API; thin — all logic in lib/store.js
  lib\
    store.js             # pure store functions, dataDir passed as parameter; unit-testable
  public\
    index.html           # entire UI, inline CSS/JS
  protocol\
    PROTOCOL.md          # canonical protocol doc; synced into data store on boot
  test\
    store.test.js        # node:test suite over lib/store.js against a temp data dir
  start-inbox.cmd        # launcher: start server + open browser
  README.md              # run/register/snippet/Task Scheduler instructions
  docs\
    2026-08-07-agent-inbox-design.md   # (already present)
```

## 2. Per-file design

### `lib/store.js`

All functions take `dataDir` explicitly. No module-level state. Synchronous `fs` throughout (single-user, local, tiny scale — simplest and avoids async races within one process). Typed errors via a `StoreError` class with `code` (`'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'IO'`) and `httpStatus` (400/404/409/500) so server.js maps errors mechanically.

Exports (signatures):

```js
class StoreError extends Error { code; httpStatus; }               // exported

ensureStore(dataDir, protocolSourcePath) -> { created: boolean, protocolSynced: boolean }
//  mkdir -p dataDir, requests\, answers\; seed projects.json with
//  {"schema_version":1,"projects":{}} if missing; copy protocol/PROTOCOL.md into
//  dataDir\PROTOCOL.md when missing OR content differs from repo copy (byte compare;
//  repo is canonical). Also regenerates all digests on boot (see ambiguity #7).

atomicWriteFile(filePath, content) -> void
//  write `${filePath}.${pid}.${randomHex}.tmp` in the SAME directory, then fs.renameSync
//  over the target (atomic-enough on same volume; Node rename overwrites on Windows).
//  On rename failure, unlink the temp file and rethrow as StoreError('IO').

validateId(id) -> boolean                       // /^[A-Za-z0-9-]+$/ , non-empty, length cap (e.g. 200)
generateId(project, title, now = new Date()) -> string
//  `<YYYYMMDD>-<project>-<kebab(title, maxlen ~40)>-<4 hex from crypto.randomBytes>`
//  kebab: lowercase, non [a-z0-9] runs -> '-', trim '-'; regenerate hex on collision.

readProjects(dataDir) -> { schema_version, projects }   // missing/corrupt file => {schema_version:1, projects:{}} (corrupt reported via listState)

listRequests(dataDir) -> { requests: Request[], invalid: {file, error}[] }
//  read every *.json in requests\; JSON.parse failures / non-object / missing core
//  fields (project, title, response.type valid) => invalid[] entry with filename +
//  message. Valid entries get id from FILENAME (canonical), body preserved verbatim.

readRequest(dataDir, id) -> Request              // throws NOT_FOUND / VALIDATION(bad id)

createRequest(dataDir, input, now = new Date()) -> Request
//  validates: project slug (^[a-z0-9-]+$), title, ask non-empty strings; response.type
//  in the 5 types; option-based types require options[] with unique non-empty keys.
//  Fills: schema_version 1, id (generateId), created ISO, status "open", answer null,
//  superseded_by null; preserves any extra fields caller passed. Writes atomically.
//  Does NOT touch digest (open requests never appear in digests).

validateAnswerShape(response, value) -> void     // throws VALIDATION with a human message
//  choice: string, must be one of options[].key
//  multi_select / checklist: array of strings, each a valid key, no duplicates (empty allowed)
//  text: non-empty string
//  approval: object with decision === "approve" | "reject"; extra keys preserved

answerRequest(dataDir, id, { value, notes, force = false }, now = new Date())
    -> { request, mirror_warnings: string[] }
//  read-modify-write preserving unknown fields: parse existing file, mutate only
//  status/answer, re-serialize the SAME object. 409 CONFLICT if status !== "open"
//  and !force. Sets answer = { value, notes? , answered_at: ISO(now) }, status
//  "answered". Atomic write -> generateDigest(project) -> mirrorDigest(project).

setStatus(dataDir, id, { status, superseded_by, returned_reason }) -> { request, mirror_warnings }
//  allowed targets: "open" (reopen), "withdrawn", "superseded" (superseded_by optional,
//  validated with validateId if present), "returned" (requires non-empty returned_reason,
//  stored on the request; only allowed from "open"; 409 on archived files). Reopen keeps
//  the old answer object AND returned_reason in place (history). Same read-modify-write
//  + digest + mirror refresh for the request's project.

archiveRequest(dataDir, id) -> { request }
//  moves requests\<id>.json to requests\archive\<id>.json (renameSync). Only allowed for
//  status answered/withdrawn/superseded — 409 otherwise, 409 if already archived. Digest
//  content is unaffected (digest scans both dirs). readRequest finds archived ids too
//  (flagged archived:true); answer/setStatus on an archived id -> 409 "archived; restore
//  by moving the file back manually". listRequests/getState exclude the archive dir.

lintClarity(request) -> string[]
//  advisory plain-language lint over title/ask/background/option labels+descriptions
//  (NOT technical_context): file-path patterns, §, ID patterns (\b[A-Z]{1,6}-\d+\b),
//  backticked code spans, ask > 400 chars. listRequests attaches the result as
//  clarity_warnings per request (read-side only — never written to disk). Never blocks.

generateDigest(dataDir, slug) -> { path, markdown, archivePath }
//  filter valid requests (live + requests\archive) to project===slug AND status in
//  (answered, superseded); sort newest first by answer.answered_at || created; render
//  spec's markdown format (header uses registered project name, falls back to slug);
//  superseded entries marked "Status: superseded — see <superseded_by || 'n/a'>". Answer
//  value rendered via option LABELS when resolvable. CAP: main digest holds the newest
//  50 entries; older entries roll into answers\<slug>-archive.md (same format), and the
//  main digest ends with a footer pointing at the archive when it is non-empty. Both
//  written atomically. Skips invalid files. Main digest written even when empty.

mirrorDigest(dataDir, slug) -> string[]          // warnings, never throws
//  no registry entry or no `mirror` => []. Resolve path.resolve(repo, mirror);
//  if resolved path escapes repo -> warning. If repo dir missing -> warning.
//  mkdir mirror's parent dirs (inside repo) if needed; atomic write of the MAIN digest
//  only (the digest archive is never mirrored). Any fs error -> push warning string, return.

getState(dataDir) -> { projects, requests, invalid }   // convenience: readProjects + listRequests
```

Schema refinement (2026-08-07, plain-language contract): requests carry an optional
`technical_context` string array — the jargon quarantine (paths, symbols, decision/section
refs, agent notes); createRequest validates and preserves it. New status `returned` with
app-written `returned_reason` (see setStatus above); digests and counts exclude it —
returned requests are "waiting on agent". PROTOCOL.md carries the normative plain-language
filing contract (60-second test, BAD→GOOD example, return-for-rewrite consequence).

### `server.js`

- Boot: `const DATA_DIR = process.env.AGENT_INBOX_DATA_DIR || path.join(os.homedir(), '.agent-inbox')` — env override exists purely so manual testing doesn't touch the real store; default matches spec. Call `ensureStore(DATA_DIR, path.join(__dirname, 'protocol', 'PROTOCOL.md'))`. Listen on `127.0.0.1`, port `Number(process.env.AGENT_INBOX_PORT) || 7717`. Log one line: URL + data dir.
- Static: `GET /` and `GET /index.html` → `public\index.html` (`Content-Type: text/html; charset=utf-8`). Any other non-`/api` path → 404. Do not implement a general static file walker — only index.html exists.
- Request hardening (all `/api` POSTs): body size cap 1 MB (destroy + 413); require `Content-Type: application/json` (415 otherwise); validate `Host` header is `127.0.0.1:<port>` or `localhost:<port>` (403 otherwise — blocks DNS-rebinding/cross-origin no-cors POSTs). No CORS headers ever.
- Routes (all responses JSON; errors `{ "error": "<message>" }` with the StoreError's httpStatus; unexpected exceptions → 500 with message — never silent):
  - `GET /api/state` → `getState(DATA_DIR)`, reads fresh every call, no cache.
  - `POST /api/requests` → body is the request input; returns `201` + created request.
  - `POST /api/requests/:id/answer` → extract id from URL, `validateId` first (400 on fail — before any fs access, this is the path-traversal gate), body `{ value, notes?, force? }` → `answerRequest` → `200` + `{ request, mirror_warnings }`. 404 unknown id, 409 non-open without `force:true`, 400 bad shape.
  - `POST /api/requests/:id/status` → body `{ status, superseded_by?, returned_reason? }` → `setStatus` → `200` + `{ request, mirror_warnings }`.
  - `POST /api/requests/:id/archive` → `archiveRequest` → `200` + `{ request }`. 409 for non-settled statuses or already-archived ids.
  - Everything else under `/api` → 404 `{ "error": "not found" }`.
- Route matching: hand-rolled — split `req.url` on `?`, match with a small regex table (`^/api/requests/([^/]+)/(answer|status|archive)$`). URL-decode before validation. No router abstraction.

### `public/index.html`

One file, three blocks: `<style>` (CSS custom properties, `@media (prefers-color-scheme: dark)` overrides), markup skeleton, `<script>` (vanilla JS, no modules). Sections:

1. **Header bar** — app title + four count badges: *Needs You* (`status==='open'`), *Blocking* (`open && blocking`), *Waiting on agent* (`returned` + unknown statuses), *Answered Today* (`answered_at` on the local calendar date).
2. **Toolbar** — filter tabs `All | Needs you | Blocking | Answered` (All includes withdrawn/superseded/unknown-status; the other tabs exclude them); search `<input>` filtering client-side over `title + ask + project` (case-insensitive substring).
3. **List pane** — rows badged by project (registered display name, else slug), showing title, project badge, urgency pill, `BLOCKING` marker, relative age, status. Sort: blocking-open first, then urgency (high>medium>low>missing), then oldest `created` first within a bucket. Clicking selects; selection tracked by id so polling doesn't lose it.
4. **Detail panel** — for the selected request: ask, background bullets, `on_answered` notes, `technical_context` collapsed under a `<details>` labeled "Agent-to-agent notes (technical)", clarity warnings (amber card, next to the Return-for-rewrite button), then a response control switched on `response.type`: radios (choice), checkboxes (multi_select), textarea (text), checkbox to-do list styling (checklist), Approve/Reject segmented buttons (approval); shared optional notes textarea; **Submit Answer** button → `POST .../answer`, plus a **Return for rewrite** button (prompts with a prefilled plain-language reason → `POST .../status` `{ status: "returned", returned_reason }`). If server returns 409, show a confirm ("Already <status> — overwrite?") that retries with `force:true`. Answered/superseded view: renders recorded answer (labels resolved) + `answered_at` + **Reopen**, **Mark superseded** (prompts for optional successor id) and **Archive** buttons (`POST .../status` / `.../archive`; archived items disappear from the app). Returned view: shows `returned_reason` (visible under All with a "returned" indicator) + Reopen/Withdraw. List rows show an amber **clarity** badge when `clarity_warnings` is non-empty. `mirror_warnings` in any response render as a dismissible warning toast.
5. **New request form** — collapsible panel/dialog: project, title, ask, urgency select, blocking checkbox, response type select, dynamic options editor (key/label/description rows) for option-based types, background bullets textarea (one per line) → `POST /api/requests`.
6. **Problems strip** — collapsed `<details>` at the bottom listing `invalid[]` as `filename — parse error`.
7. **Polling** — `setInterval(fetchState, 3000)` + fetch on load. Re-render list/counters every poll; **do not** re-render the detail panel's form controls while the user has unsaved input (track a `dirty` flag; only replace detail content when the selected request's serialized JSON actually changed and the form is pristine, otherwise show a subtle "updated on disk" hint). Fetch failure → "server unreachable" banner, keep last data.

No component framework: small render functions (`renderList(state)`, `renderDetail(req)`, `renderCounts(state)`) operating on template strings / DOM builders, one global `state` object. All user text inserted via `textContent`/escaping helper — request files are agent-authored input, treat as untrusted (XSS via a hostile title is otherwise trivial).

### `protocol/PROTOCOL.md`

Exactly the four spec sections: (1) schema_version 1 schema with the full worked example and field rules (including the answer shapes per type and the id/filename format agents must generate — plus "write via temp file + rename in the same directory" guidance so agents don't get half-read, and "re-read the whole file to poll for answers"); (2) filing rules (search `requests\` + digest first, one decision per request, sufficient background, honest `blocking`); (3) consumption rules (read `answers/<slug>.md` or in-repo mirror at task start; JSON file is machine-readable truth; never act on `superseded`); (4) the copy-paste `AGENTS.md`/`CLAUDE.md` snippet verbatim from the spec. State explicitly that agents set `status: "open"`, `answer: null`, `superseded_by: null` themselves and never write the `answer` field.

### `test/store.test.js`

`node:test` + `node:assert/strict`. Each test (or `beforeEach`) gets a fresh temp dir via `fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-test-'))`, removed in `after`. Coverage: ensureStore seeding + PROTOCOL sync/overwrite; create/list; answer round-trip for all 5 types; shape-validation rejections per type; 409 without force / success with force; id sanitation (`../evil`, `a/b`, empty, `..`); atomic write (no `*.tmp` residue after success; simulated failure leaves original intact); unknown-field preservation; digest content, ordering, superseded marking, open/withdrawn exclusion; mirror happy path + missing repo warning + `..`-escaping mirror warning; invalid-JSON tolerance.

### `start-inbox.cmd`

```bat
@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:7717
node server.js
```

### `README.md`

Run (`start-inbox.cmd` or `node server.js`), port/env override, where the data store lives, how to register a project (hand-edit `projects.json`, with the myproject example incl. `mirror`), the AGENTS.md snippet pointer, how agents file requests, `node --test` instructions, and a short "auto-start with Task Scheduler" walkthrough (instructions only — do not configure anything).

## 3. Implementation order + verification per stage

1. **Store core** — `lib/store.js`: `StoreError`, `atomicWriteFile`, `validateId`, `generateId`, `ensureStore`, `readProjects`, `listRequests`, `readRequest`, `createRequest`. Plus matching tests. *Verify:* `node --test test/` green.
2. **Mutations** — `validateAnswerShape`, `answerRequest`, `setStatus`. Extend tests: all 5 answer shapes, rejections, 409/force, unknown-field preservation, reopen. *Verify:* green.
3. **Digest + mirror** — `generateDigest`, `mirrorDigest`, wire into mutations + `ensureStore`. Extend tests. *Verify:* green.
4. **Server** — `server.js` (placeholder PROTOCOL.md ok). *Verify:* manual curl/Invoke-RestMethod against a temp `AGENT_INBOX_DATA_DIR`: state, create, answer, 409-then-force, traversal id rejected, data dir seeded.
5. **UI** — `public/index.html` against the live server. *Verify:* manual in browser (counts, tabs, search, each control type, submit, reopen/supersede, new-request form, problems strip, dark mode, poll behavior).
6. **Docs + launcher** — real `protocol/PROTOCOL.md`, `README.md`, `start-inbox.cmd`. *Verify:* tests green; PROTOCOL re-sync on restart.
7. **E2E landing gate** — real store: register `myproject` (mirror `dev\agent-answers.md`); hand-write a request JSON as an agent would; see in UI; answer; confirm JSON updated, digest regenerated, MyProject mirror written. (AGENT-BOOTSTRAP.md routing row is a separate MyProject-repo step.)

## 4. Edge cases (must handle)

- **Atomic writes**: temp file in same directory, unique name (pid + random), `renameSync` over target, temp cleanup on failure. Applies to request files, digests, mirrors, seeded files. No `*.tmp` residue.
- **Invalid JSON tolerance**: parse error / empty / non-object / missing `project`,`title`,`response.type` → `invalid[]` `{file, error}`; excluded from digests and counts; never crashes; doesn't block other requests.
- **Id sanitation**: `^[A-Za-z0-9-]+$` on URL ids before any path building (URL-decode first); also on `superseded_by`. Length cap 200. Non-`.json` files ignored; `.json` basenames failing the pattern → `invalid[]`.
- **Answer-shape validation**: choice = string ∈ keys; multi_select/checklist = string[] ⊆ keys, no dupes (empty allowed); text = non-empty string; approval = `{decision:"approve"|"reject"}` (extra keys preserved). Option-based types with missing/empty options in file → 400, not crash.
- **409 on non-open** without `force:true` (message includes current status); force overwrites. Force does not apply to `/status`.
- **Mirror failures are warnings**: unregistered project / no mirror key / repo absent / mirror path escapes repo / fs error → `mirror_warnings`, HTTP 200; order: request write → digest → mirror attempt. Normalize `\` and `/` in mirror paths.
- **Unknown-field preservation**: mutate only `status`/`answer`/`superseded_by` on the parsed object; re-serialize that object (2-space indent).
- **Digest regeneration**: full atomic rewrite after every mutation for the affected project; includes answered + superseded (marked, successor pointer), excludes open/withdrawn; newest first; all-projects regen on boot.
- **Misc**: body > 1 MB → 413; non-JSON content type → 415; ISO-8601 UTC timestamps; "Answered Today" in local time; id collision → new suffix; unknown `status` strings shown under All, excluded from digests/counts; `superseded_by` format-validated only (existence not enforced).

## 5. Resolved ambiguities

1. PROTOCOL.md sync: pure content comparison; repo copy always wins when bytes differ.
2. Never-answered superseded requests appear in digest with `**Answer:** (none — superseded by <id>)`.
3. Digest renders option **labels** (fallback raw key); multi joins with ", "; approval renders "Approved"/"Rejected".
4. Approve-with-notes = `{decision:"approve"}` + `answer.notes`; no third enum value.
5. Reopen keeps prior `answer` object (history); drops out of digest via status. UI shows previous answer faintly.
6. Filename (sans `.json`) is canonical id; body `id` preserved verbatim, mismatch tolerated. PROTOCOL tells agents to keep equal.
7. Boot-time all-project digest regeneration covers out-of-app file edits.
8. `POST /api/requests` contract: required `project`, `title`, `ask`, `response.type` (+ valid options where applicable); server fills id/created/status/answer/superseded_by/schema_version; optional `agent` (default `"human"`), `urgency` (default `"medium"`), `blocking` (default `false`), `background`, `on_answered`; extras pass through.
9. Static serving: only `/` and `/index.html`.
10. Unknown status values: not invalid; All tab only; excluded from digests/counts.
11. `superseded_by` existence not enforced.
12. Checklist is one-shot like multi_select; no partial persistence.

## 6. Security posture (from architect critique, adopted)

- `Content-Type: application/json` required + `Host` header allowlist on all API POSTs (blocks cross-origin no-cors POSTs and DNS rebinding). No CORS headers.
- All agent-authored text rendered via `textContent`/escaping in the UI (XSS).
- Sync fs is deliberate — do not convert to async.
