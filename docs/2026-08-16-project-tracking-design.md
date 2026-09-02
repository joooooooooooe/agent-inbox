# Project tracking beside the inbox, not inside it

The operator asked for the inbox to "be more of project tracking, to include features, bug tracking,
etc." (2026-08-16), prompted by having a set of long-range product ideas and nowhere good to
put them. This design says yes to the outcome and no to the literal shape: tracked items get
the inbox's store discipline, its app and its protocol, but not its list, not its schema, and
— for any project that is a git repository — not its data directory. (2026-08-16)

- **Depends on:** `protocol\PROTOCOL.md` (the question contract, unchanged by this),
  `projects.json` (repo roots), the digest/mirror pattern
- **Touches:** `server.js`, `lib\store.js`, `public\index.html`, `protocol\PROTOCOL.md`,
  `skill\agent-inbox\SKILL.md`, and one folder in each participating repo

## The recommendation, up front

**Two entity families, one house.** Questions stay exactly what they are today. Tracked items
become a second entity with its own schema, storage root and view in the app, sharing the store
layer, the server, the "file protocol is the contract" principle, and one explicit bridge: a
question can name the item it came from, and an item the questions that ruled it.

**And tracked items live in the repo they describe, not in `.agent-inbox`.** One markdown file
per item, front matter for the machine-readable part, prose body for everything else, read by
the app through the repo root already in `projects.json`.

## Goals

1. The operator has one place they look, and long-range ideas have a home that is not a wall of defects.
2. The question card's plain-language bar does not move, in either direction.
3. Filing a bug mid-task stays as cheap as today — one file write, no server, no permissions
   beyond the repo the agent is already in.
4. An agent about to touch a system can learn what is known about it without reading everything.
5. Nothing requires a scheduled human maintenance pass, because those never happen.

## Non-goals

- No priority ordering, effort estimates or severity taxonomy. See "Severity floor".
- No workflow engine: no assignment, no dependencies between items, no due dates.
- No markdown renderer in this repo. The 2026-08-11 design settled that; reuse its answer.
- No migration of closed history. Closed items stay where they died.

---

## 1. One tool or two?

### The case the operator is making

It is a good one. He has one attention surface and the inbox is already it. An answered question
routinely *becomes* work — BL-095 is literally a card id and a ruling copied out by hand, and
that copy is manual and lossy today. The store, server, atomic-write discipline and
repo-mirroring all exist and would be reused. A second local web app would be silly.

### The case against merging them into one list

The inbox's value is that its list is short and every row is a thing the operator can settle in a
minute. Both properties are structural, not cultural:

- **The list is short because questions settle and leave.** Items do not leave. MyProject has 111
  entries and roughly 60 are live; merged, questions become 5% of the rows and the "Needs You"
  count stops meaning anything.
- **The 60-second bar is enforceable because it applies to every row.** An item cannot meet it
  and should not try: BL-088's value is six paragraphs of measurement, two of them disproved
  leads kept deliberately. Once half the rows are exempt from the clarity lint, the lint is
  advice — and nobody decides to lower the bar, it just stops being the shape of the list.
- **A question is written for the operator; an item is written for the next agent.** Every field ruling
  the protocol makes follows from its audience, so a shared schema must abandon those rulings
  or misapply them.

### Three shapes

| | A: `kind` field on requests | B: separate entity, shared store | C: two tools, one bridge |
|---|---|---|---|
| Storage | `requests\<id>.json`, all together | `items\` beside `requests\` | items in the repo, questions in the store |
| App | one list, filtered | two views | two views |
| Plain-language bar | must become conditional | stays absolute on questions | stays absolute on questions |
| Bridge | free (same record) | one field each way | one field each way |
| Repo-native items | no | no | yes |

**A is rejected** — the literal reading of the operator's ask, and the one that dilutes. A conditional
lint is not a contract, and an 800-word prose body inside a JSON string field is unreadable in
a git diff and painful for an agent to write correctly. **B is the safe answer** and would
work; it fails only on question 4, because the items would sit under the operator's home directory.
**C is the recommendation:** one extra storage root in the store layer, buying everything
section 4 argues for.

He asked for one place to look and gets it, because the app reads both roots. What he does not
get is one *list* — a deliberate refusal of the thing he said, and worth him knowing. A merged
feed is a view over the same data and cheap to add later; it is just not the default, because
the default is what protects the question card.

---

## 2. The item model

### What they share, and why it is not enough

`id`, `project`, `title`, `status`, `created`, `source` — six fields of the kind any record has.
A base class over six primitives is the "seam with one implementation" the MyProject operating
model names as an overengineering smell. What divides them is bigger: a question is **a small
structured record with a little prose in it**, an item **a large prose record with a small
structured header on it**, and that inversion is the whole argument.

| | Question | Item |
|---|---|---|
| Format | JSON | markdown with YAML front matter |
| Lifetime | hours to days | weeks to forever |
| Written for | the operator | the next agent |
| Written by | agent, once | many agents, appended to over months |
| Ends when | answered — that is the point | fixed or absorbed, or never |
| Prose bar | 60-second test, linted | none; jargon is the content |

BL-088's entry was written by at least four different agents over three days, each appending a
paragraph that disproved the previous one's lead. That access pattern — append prose, never
rewrite — is what markdown is for and what JSON is bad at.

### Kinds — two, not three, because `areas/` already exists

**`bug` and `idea`.** They are already the two things in the backlog and are read at different
moments: one when something is broken, one when planning. No `task`, no `epic`, no `note` —
what breaks without them is nothing; a task is a plan milestone, a note belongs in `notes/`,
and the repo routes both.

An earlier draft proposed a third kind, `vision`, on the grounds that a long-range idea buried
under 55 open defects is never seen again. That was written without checking whether the repo
had already solved it. It has.

`Assets\_Project\Docs\areas\*.md` is a per-area reference layer, routed by `DOCS-INDEX.md` as
*"read only the areas your task touches"*, and `areas\new-project-wizard.md` is a full vision
document — acceptance bar, core model, family walkthrough, boundaries — marked *"captured
direction, not scheduled work"* and pointed at from the plan's open decisions. Three more are
being written this week. It is a better home than any tracker item: it has headings, it grows,
and it is what a workstream reads before building.

So a vision goes in **an area document, not a tracker item**, and `vision` is cut. Nothing
breaks, provided the two layers are joined — one convention, no schema:

- **`systems` uses the area vocabulary.** Where an area document exists, its filename is the
  system name. An item serving the wizard carries `systems: [new-project-wizard]`, making
  BL-037, BL-104, BL-109 and BL-111 reachable from the wizard's own name in one grep. Today
  they are connected only by that area doc naming BL-037 by hand.
- **The app lists the project's area documents beside the tracker** (section 7). Zero protocol,
  zero schema: a directory listing and an H1.

The tell is status. An **area document** is a place: no status, no end, describing how part of
the game should be. An **item** has a status and finishes. Had `vision` shipped, the operator's wizard
prose would have two homes and the tracker's copy would be the stale one.

### Front matter — the complete field list

```yaml
id: BL-088
kind: bug
status: fixed
systems: [possession, online, creatures]
created: 2026-08-13
updated: 2026-08-15
source: the operator, round-7 play card
answers: [20260814-myproject-getting-out-in-mid-air-2f7c]
```

Every field, floor-tested — *what breaks if it is absent?*

| Field | What breaks without it |
|---|---|
| `id` | Citations rot. BL-105's own entry exists only because the number appears in commit messages and code comments and must not be reissued. |
| `kind` | You cannot separate "this is broken" from "this could be better" — a fix list and a planning input read at different moments. |
| `status` | You cannot tell a live item from a dead one without reading it. |
| `systems` | **The read path dies.** The highest-value field: a declared, closed vocabulary shared with the area documents (section 2). |
| `created` / `updated` | You cannot tell a stale hypothesis from a current one, and the backlog is full of both. |
| `source` | You cannot tell the operator's direction from an agent's opinion — and the operating model grades those differently. |
| `answers` | The bridge to the inbox. Rulings drift away from the items they rule. |

### Fields deliberately not in the list

- **`severity` / `priority`.** One developer, one screen, sorted by looking — and a severity
  taxonomy is named as overhead in the operating model by that exact word.
- **`repro`.** Bug bodies already carry measurements far richer than any repro field, and a
  half-filled field is worse than a convention.
- **`evidence` / `links`.** Paths in the prose are already clickable via the 2026-08-11 feature.
- **`assignee` / `estimate` / `blocked_by`.** Agents are dispatched by an orchestrator reading
  state, not by a queue.
- **`closed_by`.** Tempting — you want to know where an absorbed item went — but the closing
  sentence of the prose always says, and two places means they will disagree. Convention, not
  field.

What breaks without any of them: nothing.

---

## 3. Status and lifecycle

The backlog's stated schema has seven states. Live usage across 111 entries: `triaged` ~55,
`absorbed` ~33, `done` 11, `inbox` 11, `captured` 3, `fixed` 3, and one each of `candidate`,
`wont-do` and `built, awaiting review`. Of those, `done`, `captured`, `fixed`, `wont-do` and
`built, awaiting review` are not in the schema at all. `research`, `ready-to-propose` and
`rejected` are, and have zero uses.

Three official states have never been used once, five unofficial ones were invented under
pressure, and that drift is the most useful data in this document. It says two things.

**The schema had no terminal-success state.** It assumed items always *leave* by being
`absorbed` into a plan; in practice fourteen were simply fixed in place by whoever was passing,
and had to invent `done` and `fixed` to say so. Any tracker assuming work flows through a
promotion pipeline will be lied to by this project — and **the pipeline itself is fiction**:
`research`, `ready-to-propose` and `candidate` describe a triage nobody runs, and `rejected`
lost to `wont-do`, which is what a person actually types.

### Proposed states

| State | Meaning |
|---|---|
| `open` | Real, nobody is on it. |
| `active` | Someone is on it right now. |
| `fixed` | Done, in this repo, over. |
| `absorbed` | Moved into a plan or portfolio; it lives on somewhere else. |
| `wont-do` | Deliberately not doing it. |

Five, and they are the five live usage converged on with the ceremony removed.

- `open` merges `inbox`, `captured`, `triaged` and `candidate`. What breaks: the "someone
  confirmed this is real" signal. A genuine loss — but it is a *sentence*, not a state; nothing
  branched on it, and the split produced four names for one condition.
- `active` earns its place on the operating model's first principle: stopping parallel agents
  colliding. Two agents independently fixing BL-106 is exactly the waste it exists to prevent.
- `wont-do` must stay distinct from `fixed`. BL-096 exists *solely* so a future agent stops and
  does not "fix" a deliberate mismatch; it must never read as a to-do.

**No "awaiting the operator's eyes" state**, despite that being a real condition here (BL-105: *"the operator's
eyes still owed"*). It is orthogonal to all five, and it already has a tool: the item files a
question in the inbox and names it in `answers` — the bridge earning its keep, not a sixth state.

---

## 4. Where the data lives — the crux

### What is load-bearing about the repo

`BACKLOG.md` sits in the MyProject git repository, and moving it to `C:\Users\operator\.agent-inbox`
would cost all of the following:

1. **Atomicity with the fix.** "Fix the bug and close the item" is one commit today; split the
   store and it becomes a commit plus an out-of-band write that can be forgotten.
2. **Revertability.** Reverting a bad fix reverts the item's state with it. Across stores, no.
3. **History and review for free.** `git log` is the item's history — BL-088's four
   contradicting agents are individually attributable — and the text is in the diff the
   reviewer is already reading.
4. **Reachability.** An agent in a worktree, on another machine, or in a cloud sandbox has the
   repo and nothing else. A home-directory store is invisible to all three.
5. **Backup.** The repo is pushed. The home directory is not.

None is decisive alone. Together they are the difference between a tracker agents use and one
they forget.

### Three options

**Option 1 — store-of-record in `.agent-inbox`, generated mirror in the repo.** The digest
pattern, extended. Simplest to build; the app owns every write; one storage root. **Rejected:**
the mirror is generated, so it is read-only to agents — the write path leaves the repo and every
property above is lost except backup. It also inverts the cost that matters, since agents write
items far more often than the operator reads them, so the cheap path should be the agent's.

**Option 2 — store-of-record in the repo for everything, including questions.** Inverts today's
direction entirely. **Rejected:** questions are cross-project by nature, several of the operator's
projects are not git repos, and a question about which project to do first belongs to neither.
(An earlier draft also rejected it for making the app a repo writer. That reason was wrong and
is withdrawn — see the next subsection.)

**Option 3 — split by entity type. Recommended.**

- Questions: `C:\Users\operator\.agent-inbox\requests\<id>.json`. Unchanged.
- Items: `<repo>\<tracker-path>\<id>.md`, one file per item.
- `projects.json` gains one optional field beside `mirror`:

```json
"myproject": {
  "name": "MyProject",
  "repo": "C:\\Users\\operator\\MyProject",
  "mirror": "dev\\agent-answers.md",
  "tracker": "Assets\\_Project\\Docs\\tracker"
}
```

- Projects with no `repo` or no `tracker` fall back to `.agent-inbox\items\<slug>\`. Without the
  fallback, the operator's non-code projects cannot track anything; it is one root-resolution function,
  not a second code path.

The founding principle survives: the file protocol is still the contract, and still works with
no server running.

### The app writing into the repo

Putting items in the repo and then letting the operator flip their status in the app makes the app a
writer into a git working tree — in MyProject, one with roughly 40,000 untracked files, a
pre-push hook, and a standing ban on `git add -A`. This is the sharpest problem in the design
and it is not resolved by wishing the app were read-only.

**The fact that settles most of it: the app already does this, and has since day one.**
`mirrorDigest` writes `dev\agent-answers.md` into the MyProject working tree after *every* answer
and status change, and that file is dirty in the tree right now. Nine days, no incident. So "the
app must never touch the repo" is not a principle this tool has ever held; the one it does hold
is that **agents never depend on the app**, and no option below touches that.

| Option | Cost |
|---|---|
| **(a) Write the file, leave it dirty** | A stale uncommitted edit can be clobbered by an agent that writes the same file, or swept into an unrelated commit. Both are already true of the mirror. |
| **(b) Never write; queue the change for an agent** | Keeps the app literally read-only, and costs the operator the one thing a human wants from a tracker: ticking something off. A close would need an agent session. |
| **(c) Status in a store-side overlay, body in the repo** | Splits the single most important field across two stores, and destroys atomicity-with-the-fix — the best argument for repo storage in the first place. |
| **(d) The app commits its own change** | Honest and leaves no dirt, but the viewer now runs git: it must use the pathspec form so it cannot sweep an agent's staged index, refuse to act mid-merge or mid-rebase, and it leaves an unpushed commit the next agent's push gate did not write. |

**Recommendation: (a), with two guards** — it is the status quo extended by one file, which is
the strongest evidence available that it survives contact with this repo. The guards: the app
writes **exactly one line, the front-matter `status:`, and never body prose**, so a concurrent
agent edit costs at most a flip the operator redoes in a second; and the Tracking view **badges any item
whose file is uncommitted**, so it gets committed rather than found a week later.

(d) is the better long-term answer and should be reconsidered if dirty tracker files start
getting lost. It is not the first move, because it turns a viewer into a thing that writes
history.

### Why one file per item, not one file with many items

The same argument the inbox already made for `requests\<id>.json`:

- **No write contention.** Two agents filing concurrently touch different files; today they
  both append to line 13 of `BACKLOG.md` and merge badly.
- **`git log` per item, free**, and the diff in the fixing commit is the item, not a hunk.
- **A grep hit is a whole file**, not an offset into a wall — see the read path in section 6.

The cost: you can no longer read the whole backlog in one call. Nobody usefully did that at 834
lines anyway, and the operator has the app.

---

## 5. Migration, and what stops the new wall

### Freeze, do not convert

`BACKLOG.md` stays where it is, with a header saying it is closed to new entries and where the
live tracker is. The ~50 closed entries (`absorbed`, `done`, `fixed`, `wont-do`) **stay in it
forever** — migrating a dead item buys nothing and costs a review. Only the ~60 live entries
move, and their headers are mechanical: `State:`, `Related system:`, `Source:` and the date are
already labelled prose in a consistent shape, so an agent lifts them into front matter with a
human skimming the result.

**The bodies are copied verbatim, byte for byte.** No summarising, no tidying, no "cleaning up
superseded hypotheses". BL-088 keeps all six paragraphs including both disproved leads, each
bought with a measurement session that re-following would waste again. A migration pass that
"improves" the prose is the most expensive mistake available here.

### What keeps it small

**One rule, and it fires automatically.** When an agent sets an item to `fixed`, `absorbed` or
`wont-do`, it moves the file to `tracker\closed\` in the same commit. Git keeps the history
across the rename. The open set is then literally the directory listing.

**Nothing else** — no periodic review sweep, no expiry, no "close if untouched for 90 days",
and there is proof rather than opinion behind that. `BACKLOG.md`'s front matter has promised
since day one that *"rejected and absorbed items move to BACKLOG-ARCHIVE.md periodically"*.
There are 33 absorbed items and **`BACKLOG-ARCHIVE.md` does not exist**. Any policy needing a
scheduled human pass is dead on arrival here; the ones that work ride along with work someone
was already doing. What breaks without them: nothing. An old idea costs one file that surfaces
only when someone greps its system.

---

## 6. What agents do differently

### Write path — it must not get more expensive

Today: one `Edit` appending a bullet to a file already in the repo. Proposed: one `Write`
creating `tracker\BL-112.md`. Same tool count, same permissions, no server — slightly
*cheaper*, since it does not require reading the target file first.

**Id allocation, and the collision this repo actually produces.** The inbox's own scheme
(`<date>-<kebab>-<hex>`) needs no counter but produces ids nobody says out loud, and this
project cites `BL-###` in commit messages and code comments. Max-existing-plus-one keeps the
speakable form, but the failure here is worse than a generic merge conflict: agents in this
repo commit **directly to `main`**, concurrently, checking `git log origin/main..main` before
pushing. Two agents allocating `BL-112` produce a same-path conflict on the second push, and
the fix is to renumber one — **exactly the renumbered citation the `id` field exists to
prevent.**

**Recommendation: keep `BL-###`, plus one rule — a number is not citable until it is pushed.**
No naming a new item's number in a commit message, code comment or other document in the same
commit that creates it. After the push it is uncontested and citable forever, which is when
citation happens anyway: BL-105 is cited by the commits that *fixed* it, days later. A
collision then costs a file rename and nothing else.

The alternative worth naming is a random speakable suffix (`BL-7K2Q`), collision-proof enough
to cite immediately but losing the "higher number is newer" ordering that makes a bare list
readable. If the operator would rather never think about this again, that is the trade; as written, the
citation rule is cheaper.

### Read path — the real win, which is smaller than it looks

The claim that an agent must read all 834 lines of `BACKLOG.md` today is false, and worth
retracting: `Grep` with context already works, and agents here are instructed to search rather
than read wholesale. The win is real but narrower, and it is threefold:

```
Grep   "systems:.*possession"   over tracker/   →   BL-087.md, BL-088.md, BL-095.md, BL-106.md
```

1. **Declared, not incidental.** `systems:` is a field, so a match means the item *is about*
   possession. Grepping the word `possession` in prose today also returns every entry that
   merely mentions it — BL-088's body alone names four systems it is not filed under.
2. **Bounded.** A hit returns a whole small file you can read to the end. A hit in
   `BACKLOG.md` returns a line offset into a 3,000-word entry with no marked end, so the agent
   either reads too little or pulls a large window and hopes.
3. **Header before body.** Status, kind and date are readable without the body, so an agent can
   discard the closed and the stale before spending a read on them.

One sentence goes into the repo's bootstrap routing: *before touching a system, grep the
tracker for that system's name; before filing, grep it again so you do not file a duplicate* —
the same "search before you file" rule `PROTOCOL.md` section 3 already imposes on questions.

**No generated index file.** It is the obvious thing to add and it is exactly what would become
the new 834-line wall — plus it would be stale for any agent working while the server is down.
Grep is always accurate and costs the same. The operator's list is generated live in the app, where it
is free.

---

## 7. App surface

Short, because the protocol is the product.

- **A second top-level view, "Tracking", beside the questions list.** Grouped by kind, filtered
  by status and by system, searchable over title and body.
- **Read-only body rendering** via the mechanism the 2026-08-11 design established: no markdown
  renderer, hand the file to Sublime. An item *is* a markdown file at a real path, so this is
  straight reuse rather than a new capability.
- **The project's area documents listed beside the tracker**, read-only, straight from the
  `areas\` folder — filename and H1, opening in Sublime on click. This is what gives the operator's
  long-range ideas a visible home without a `vision` kind (section 2).
- **Exactly two write actions:** change status, and "ask the operator about this", which opens the
  existing new-question form pre-linked to the item.
- **Badges** on a question that came from an item and vice versa, and on any uncommitted item.

The status flip writes one front-matter line into the repo and leaves it dirty, per section 4.
Everything else is read-only: the app never writes item prose, because that is the agents' job
and it belongs in their commits.

---

## 8. Cross-project

Tracking is portable by construction, because the storage root is per-project. Any project with
a `repo` gets a tracker by adding one line to `projects.json` and creating the folder; any
project without one falls back to the data store. Nothing here is MyProject-specific except that
MyProject is where the incumbent tracker happens to live. The conventions that belong to that project's
work — what counts as a system name, how items relate to plans — stay in that repo's own docs;
the tracker knows only that `systems` is a list of strings.

---

## Worked example — BL-088 in the proposed schema

The hardest real entry: six paragraphs, four authors, three days, two disproved leads kept
deliberately, and a title that its own author says is now wrong.

`Assets\_Project\Docs\tracker\closed\BL-088.md`:

```markdown
---
id: BL-088
kind: bug
status: fixed
systems: [possession, online, creatures]
created: 2026-08-13
updated: 2026-08-15
source: the operator, round-7 play card
answers: [20260815-myproject-clean-slate-cd68]
---

# A remote player who gets off the wolf loses their body, every single time

> **Read this line and the last bullet; everything between is the history of two wrong leads,
> kept because each was disproved by measurement and re-following either wastes a session.** …

- **Value (as first reported, before the re-test corrected it):** …
- **NOT cured by `9914e12`, and the review says why …**
- **the operator re-tested it on the `c165cd1` build and the title is now wrong** …
- **The lead above was probed and it is WRONG, measured 2026-08-14.** …
- **Diagnosed on two built windows, 2026-08-14** (`a91b3c5`). …
```

**What changed:** eight lines of front matter, the title promoted to a heading, the state
sentence lifted out of the trailing prose. The body is untouched — the ellipses are abbreviation
for this document only; migration copies every word. **What it costs:** eight lines per item,
and 111 files where there was one.

**What it buys, concretely, for this entry:**

- An agent on vehicles never matches it. Grepping the *word* today does: this body mentions
  vehicles, the car, and BL-084 without being about any of them.
- An agent on possession gets a bounded file, and knows from the header alone that it is closed,
  recent and the operator-sourced before reading a line — where today the same hit is an offset into
  3,000 words with no marked end.
- The disproved leads survive intact, costing nothing to anyone not working on possession.
- `git log` on the file names the four agents and the order they were wrong in, and the fixing
  commit contains the state change and the move to `closed\`.

Note what the header does **not** contain: no severity, priority, estimate, repro or evidence
field. This is the messiest entry in the backlog and none of them would have carried
information the prose does not carry better.

---

## Severity floor applied to this design

Every piece of structure above states inline what breaks without it. The things cut for failing
that test, collected:

| Cut | Why |
|---|---|
| A single merged list | Erodes the 60-second bar; question rows become 5% of the list |
| A shared schema with a `kind` field | Six shared primitive fields is not a base class |
| `severity`, `priority`, `estimate` | One developer, one screen; the operating model names taxonomies as overhead |
| `repro`, `evidence`, `links`, `assignee`, `blocked_by`, `closed_by` | Prose and existing tools already carry all of it |
| `inbox` / `captured` / `triaged` / `candidate` as distinct states | Four names for one condition; nothing branched on the difference |
| `research`, `ready-to-propose`, `rejected` | Zero uses in 111 entries |
| An "awaiting the operator's eyes" state | It is a question, and the inbox already handles questions |
| A `vision` kind, and an `area` pointer field | `areas\*.md` is already the home; `systems` reaches it, so both would only fragment the prose |
| A generated index file | Becomes the new wall; grep is accurate and equally cheap |
| A periodic review or staleness sweep | The existing one has never run once in the backlog's life |
| Migrating closed entries | Buys nothing, costs a review, risks damaging kept prose |

The structure that survives is: eight front-matter fields, two kinds, five states, one automatic
move on close, one folder per project, and one sentence added to each repo's routing doc.

---

## Open questions for the operator

1. When something is fixed, do you want to be asked to look at it in the game before it counts
   as finished — every time, or only when the person who fixed it thinks it matters?

2. Your biggest long-range ideas already have their own write-ups. Should those appear in this
   tool beside the bug list so everything is visible in one place, or stay separate?

3. When you open this, do you want one list covering all your projects at once, or one project
   at a time?

4. Do you want to be able to write and edit these entries yourself in the app, or is it enough
   to read them and mark things open or closed while the agents do the writing?

5. Old ideas that nobody has touched in months: keep them forever so they can resurface, or
   would you rather they quietly disappear?
