# Clickable Markdown Links Implementation Plan

> **Superseded (2026-09-01).** Task 3's `POST /api/open` route and the Sublime launcher no
> longer exist: documents are rendered in the app instead. The path resolution and its tests
> live on in `lib/documents.js`. Kept as the record of how this was built.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make markdown paths written by agents in request cards clickable, so one click opens the file in Sublime Text and renders it in the browser.

**Architecture:** A new `lib/open-file.js` resolves a card-supplied path against its project's repo root and validates it, then launches Sublime via injected `spawn`. `server.js` gains a thin `POST /api/open` route. A new `public/linkify.js` (dual browser-global / CommonJS so it is unit-testable) splits prose into text nodes and anchors, wired into the four rendered card fields.

**Tech Stack:** Node ≥ 20, zero npm dependencies, no build step. `node:test` for tests. Sublime Text 4 `subl.exe` with `--command`.

**Spec:** `docs/2026-08-11-clickable-markdown-links-design.md`

---

### Task 1: Path resolution and validation

**Files:**
- Create: `lib/open-file.js`
- Test: `test/open-file.test.js`

- [ ] **Step 1: Write the failing tests**

```js
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const openFile = require('../lib/open-file');
const store = require('../lib/store');

const tmpDirs = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-open-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});

// Builds a data dir with one project whose repo contains docs/note.md.
function fixture() {
  const root = makeTmp();
  const dataDir = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(dataDir, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), '# note\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'docs', 'data.txt'), 'not markdown\n', 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify({ schema_version: 1, projects: { demo: { name: 'Demo', repo } } }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'requests', 'req-1.json'),
    JSON.stringify({
      schema_version: 1, id: 'req-1', project: 'demo', agent: 'claude-code',
      title: 'demo', ask: 'demo?', urgency: 'low', blocking: false,
      response: { type: 'approval' }, created: '2026-08-11T00:00:00.000Z', status: 'open',
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'requests', 'req-orphan.json'),
    JSON.stringify({
      schema_version: 1, id: 'req-orphan', project: 'ghost', agent: 'claude-code',
      title: 'demo', ask: 'demo?', urgency: 'low', blocking: false,
      response: { type: 'approval' }, created: '2026-08-11T00:00:00.000Z', status: 'open',
    }, null, 2),
    'utf8',
  );
  return { dataDir, repo };
}

function expectStoreError(fn, codeWanted) {
  try {
    fn();
    assert.fail('expected a StoreError');
  } catch (err) {
    assert.ok(err instanceof store.StoreError, `expected StoreError, got ${err.name}`);
    assert.equal(err.code, codeWanted);
    return err;
  }
}

test('resolves a repo-relative path with forward slashes', () => {
  const { dataDir, repo } = fixture();
  const abs = openFile.resolveMarkdownPath(dataDir, 'req-1', 'docs/note.md');
  assert.equal(abs, path.join(repo, 'docs', 'note.md'));
});

test('resolves a repo-relative path with backslashes', () => {
  const { dataDir, repo } = fixture();
  const abs = openFile.resolveMarkdownPath(dataDir, 'req-1', 'docs\\note.md');
  assert.equal(abs, path.join(repo, 'docs', 'note.md'));
});

test('accepts an absolute path inside the repo', () => {
  const { dataDir, repo } = fixture();
  const abs = openFile.resolveMarkdownPath(dataDir, 'req-1', path.join(repo, 'docs', 'note.md'));
  assert.equal(abs, path.join(repo, 'docs', 'note.md'));
});

test('rejects traversal above the repo root', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => openFile.resolveMarkdownPath(dataDir, 'req-1', '../../secrets.md'),
    'VALIDATION',
  );
});

test('rejects a sibling directory sharing the repo name prefix', () => {
  const { dataDir, repo } = fixture();
  const evil = `${repo}-evil`;
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'note.md'), '# evil\n', 'utf8');
  expectStoreError(
    () => openFile.resolveMarkdownPath(dataDir, 'req-1', path.join(evil, 'note.md')),
    'VALIDATION',
  );
});

test('rejects a non-markdown extension', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => openFile.resolveMarkdownPath(dataDir, 'req-1', 'docs/data.txt'),
    'VALIDATION',
  );
});

test('accepts an uppercase .MD extension', () => {
  const { dataDir, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'docs', 'SHOUT.MD'), '# shout\n', 'utf8');
  const abs = openFile.resolveMarkdownPath(dataDir, 'req-1', 'docs/SHOUT.MD');
  assert.equal(abs, path.join(repo, 'docs', 'SHOUT.MD'));
});

test('rejects a markdown path that does not exist', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => openFile.resolveMarkdownPath(dataDir, 'req-1', 'docs/missing.md'),
    'NOT_FOUND',
  );
});

test('rejects a directory even when it ends in .md', () => {
  const { dataDir, repo } = fixture();
  fs.mkdirSync(path.join(repo, 'docs', 'folder.md'), { recursive: true });
  expectStoreError(
    () => openFile.resolveMarkdownPath(dataDir, 'req-1', 'docs/folder.md'),
    'VALIDATION',
  );
});

test('rejects a project missing from the registry', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => openFile.resolveMarkdownPath(dataDir, 'req-orphan', 'docs/note.md'),
    'NOT_FOUND',
  );
});

test('rejects an unknown request id', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => openFile.resolveMarkdownPath(dataDir, 'req-nope', 'docs/note.md'),
    'NOT_FOUND',
  );
});

test('rejects an empty path', () => {
  const { dataDir } = fixture();
  expectStoreError(() => openFile.resolveMarkdownPath(dataDir, 'req-1', '  '), 'VALIDATION');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/open-file'`

- [ ] **Step 3: Write `lib/open-file.js` (resolution half only)**

```js
'use strict';

// Resolves a card-supplied markdown path to an absolute path inside that
// card's project repo, then launches Sublime Text to open and render it.
//
// This module turns request-body input into a process spawn, so the
// validation in resolveMarkdownPath is the security boundary. Keep it strict.

const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');

function fail(code, message) {
  throw new store.StoreError(code, message);
}

// True when child is the same path as parent, or sits beneath it. Compares
// against parent + separator so a sibling like "repo-evil" cannot pass a
// naive prefix test against "repo".
function isInside(parent, child) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  if (a === b) return true;
  const withSep = a.endsWith(path.sep) ? a : a + path.sep;
  // Windows paths are case-insensitive; compare accordingly on win32.
  if (process.platform === 'win32') {
    return b.toLowerCase().startsWith(withSep.toLowerCase());
  }
  return b.startsWith(withSep);
}

function resolveMarkdownPath(dataDir, id, rawPath) {
  const raw = String(rawPath == null ? '' : rawPath).trim();
  if (raw === '') fail('VALIDATION', 'no file path was given');

  // readRequest covers live and archived cards, and throws NOT_FOUND itself.
  const request = store.readRequest(dataDir, id);
  const slug = request.project;

  const registry = store.readProjects(dataDir);
  const project = registry.projects && registry.projects[slug];
  if (!project || !project.repo) {
    fail('NOT_FOUND', `project "${slug}" is not registered in projects.json, so "${raw}" cannot be resolved`);
  }
  const repoRoot = path.resolve(project.repo);

  const normalised = raw.replace(/\//g, path.sep).replace(/\\/g, path.sep);
  const abs = path.resolve(repoRoot, normalised);

  if (!isInside(repoRoot, abs)) {
    fail('VALIDATION', `"${raw}" resolves outside the ${slug} repo (${repoRoot})`);
  }
  if (!/\.md$/i.test(abs)) {
    fail('VALIDATION', `"${raw}" is not a markdown file`);
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') fail('NOT_FOUND', `no file at ${abs}`);
    fail('IO', `could not read ${abs}: ${err.message}`);
  }
  if (!stat.isFile()) fail('VALIDATION', `${abs} is not a file`);

  return abs;
}

module.exports = { resolveMarkdownPath, isInside };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all 12 new tests green, existing tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add lib/open-file.js test/open-file.test.js
git commit -m "Add markdown path resolution for card links"
```

---

### Task 2: Editor launch with injected spawn

**Files:**
- Modify: `lib/open-file.js`
- Test: `test/open-file.test.js`

- [ ] **Step 1: Write the failing tests (append to `test/open-file.test.js`)**

```js
// --- editor launch -------------------------------------------------------

function fakeSpawner() {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return { unref() {}, on() {} };
  };
  return { calls, spawn };
}

test('launch opens the file then sends the preview command', async () => {
  const { calls, spawn } = fakeSpawner();
  await openFile.launchEditor('C:\\repo\\docs\\note.md', {
    spawn,
    sublPath: 'C:\\subl.exe',
    isRunning: () => true,
    delay: () => Promise.resolve(),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { cmd: 'C:\\subl.exe', args: ['C:\\repo\\docs\\note.md'] });
  assert.equal(calls[1].args[0], '--command');
  assert.match(calls[1].args[1], /^markdown_preview /);
  assert.match(calls[1].args[1], /"target": ?"browser"/);
});

test('launch passes arguments as argv, never as a shell string', async () => {
  const { calls, spawn } = fakeSpawner();
  const nasty = 'C:\\repo\\docs\\a b & calc.md';
  await openFile.launchEditor(nasty, {
    spawn, sublPath: 'C:\\subl.exe', isRunning: () => true, delay: () => Promise.resolve(),
  });
  // The path survives intact as a single argv entry rather than being split
  // or interpreted, which is what makes shell metacharacters harmless.
  assert.deepEqual(calls[0].args, [nasty]);
});

test('launch waits for a cold editor to appear before sending the command', async () => {
  const { calls, spawn } = fakeSpawner();
  let probes = 0;
  await openFile.launchEditor('C:\\repo\\docs\\note.md', {
    spawn,
    sublPath: 'C:\\subl.exe',
    isRunning: () => { probes += 1; return probes > 3; },
    delay: () => Promise.resolve(),
  });
  assert.ok(probes > 3, 'should have polled until the editor appeared');
  assert.equal(calls.length, 2, 'still exactly two spawns');
});

test('launch gives up waiting after the probe budget and still sends the command', async () => {
  const { calls, spawn } = fakeSpawner();
  await openFile.launchEditor('C:\\repo\\docs\\note.md', {
    spawn,
    sublPath: 'C:\\subl.exe',
    isRunning: () => false,
    delay: () => Promise.resolve(),
    maxProbes: 5,
  });
  assert.equal(calls.length, 2, 'sends the preview command even if detection never succeeded');
});

test('launch fails clearly when the editor binary is missing', async () => {
  const spawn = () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; };
  await assert.rejects(
    () => openFile.launchEditor('C:\\repo\\docs\\note.md', {
      spawn, sublPath: 'C:\\nope\\subl.exe', isRunning: () => true, delay: () => Promise.resolve(),
    }),
    (err) => err instanceof store.StoreError && /C:\\nope\\subl\.exe/.test(err.message),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `openFile.launchEditor is not a function`

- [ ] **Step 3: Add the launch half to `lib/open-file.js`**

Add these requires at the top, beside the existing ones:

```js
const { spawn: nodeSpawn, execFileSync } = require('node:child_process');
```

Add above `module.exports`:

```js
const DEFAULT_SUBL = process.env.AGENT_INBOX_SUBL
  || 'C:\\Program Files\\Sublime Text\\subl.exe';

const PREVIEW_COMMAND = 'markdown_preview {"target": "browser", "parser": "markdown"}';

const WARM_SETTLE_MS = 250;   // editor already up: just let the view load
const PROBE_MS = 250;         // gap between cold-start liveness probes
const COLD_SETTLE_MS = 750;   // after the process appears, before commanding
const MAX_PROBES = 40;        // ~10s ceiling on waiting for a cold editor

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Windows-only liveness probe. Any failure is reported as "not running", which
// costs a short wait rather than breaking the launch.
function editorIsRunning() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq sublime_text.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    return /sublime_text\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

function launchProblem(cmd, message) {
  return `could not launch the editor at ${cmd}: ${message}. `
    + 'Set AGENT_INBOX_SUBL if Sublime Text lives elsewhere.';
}

function runDetached(spawn, cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.unref === 'function') child.unref();
    // A missing binary surfaces as an asynchronous 'error' event, not a throw,
    // so this handler is the only place a bad AGENT_INBOX_SUBL becomes visible.
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => console.error(`[agent-inbox] ${launchProblem(cmd, err.message)}`));
    }
  } catch (err) {
    fail('IO', launchProblem(cmd, err.message));
  }
}

// Opens absPath, then asks Sublime to render it via the MarkdownPreview
// package. The two calls are separate because `subl --command` acts on the
// active view, so the file has to be loaded first.
async function launchEditor(absPath, options = {}) {
  const spawn = options.spawn || nodeSpawn;
  const sublPath = options.sublPath || DEFAULT_SUBL;
  const isRunning = options.isRunning || editorIsRunning;
  const delay = options.delay || sleep;
  const maxProbes = options.maxProbes || MAX_PROBES;

  const wasRunning = isRunning();
  runDetached(spawn, sublPath, [absPath]);

  if (wasRunning) {
    await delay(WARM_SETTLE_MS);
  } else {
    // Cold start: poll until the process exists rather than retrying the
    // command, which would risk opening two browser tabs.
    for (let i = 0; i < maxProbes; i += 1) {
      await delay(PROBE_MS);
      if (isRunning()) break;
    }
    await delay(COLD_SETTLE_MS);
  }

  runDetached(spawn, sublPath, ['--command', PREVIEW_COMMAND]);
}
```

Update the exports line:

```js
module.exports = { resolveMarkdownPath, isInside, launchEditor, DEFAULT_SUBL };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. No Sublime window opens — every test injects `spawn`.

- [ ] **Step 5: Commit**

```bash
git add lib/open-file.js test/open-file.test.js
git commit -m "Add Sublime launch with cold-start handling"
```

---

### Task 3: The `POST /api/open` route

**Files:**
- Modify: `server.js:101-138` (the `handlePost` function) and `server.js:151` (the POST guard block)

- [ ] **Step 1: Add the require**

In `server.js`, beside `const store = require('./lib/store');`:

```js
const openFile = require('./lib/open-file');
```

- [ ] **Step 2: Add the route to `handlePost`**

At the top of `handlePost`, before the existing `if (pathname === '/api/requests')` line:

```js
  if (pathname === '/api/open') {
    const abs = openFile.resolveMarkdownPath(DATA_DIR, body.id, body.path);
    // Fire and forget: the browser should not wait on a cold editor start.
    openFile.launchEditor(abs).catch((err) => {
      console.error(`[agent-inbox] launching the editor failed: ${err.message}`);
    });
    return sendJson(res, 200, { ok: true, path: abs });
  }
```

Resolution runs synchronously so a bad path still returns 400/404 to the caller; only the launch is detached.

- [ ] **Step 3: Verify the route by hand**

Start the server in one terminal:

```bash
node server.js
```

In another, with a real open card id and path:

```bash
curl -s -X POST http://127.0.0.1:7717/api/open -H "Content-Type: application/json" -d "{\"id\":\"20260811-example-notes-review-the-report-43e6\",\"path\":\"out/review_report.md\"}"
```

Expected: `{"ok":true,"path":"C:\\Users\\operator\\Example Notes\\out\\review_report.md"}`, Sublime opens the file, Edge renders it.

Then confirm a traversal attempt is refused:

```bash
curl -s -X POST http://127.0.0.1:7717/api/open -H "Content-Type: application/json" -d "{\"id\":\"20260811-example-notes-review-the-report-43e6\",\"path\":\"../../../Windows/system.ini\"}"
```

Expected: HTTP 400 with a message naming the repo it resolved outside of. No process launched.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Add POST /api/open route"
```

---

### Task 4: Client-side linkification

**Files:**
- Create: `public/linkify.js`
- Test: `test/linkify.test.js`
- Modify: `public/index.html` (script tag; `bulletSection`; the `ask` and `technical_context` renderers)

- [ ] **Step 1: Write the failing tests**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitMarkdownPaths } = require('../public/linkify');

test('returns a single text part when there is no markdown path', () => {
  assert.deepEqual(splitMarkdownPaths('nothing to see here'), [
    { type: 'text', value: 'nothing to see here' },
  ]);
});

test('splits a repo-relative path out of surrounding prose', () => {
  assert.deepEqual(splitMarkdownPaths('The 41 are listed in out/review_F.md, with a summary.'), [
    { type: 'text', value: 'The 41 are listed in ' },
    { type: 'path', value: 'out/review_F.md' },
    { type: 'text', value: ', with a summary.' },
  ]);
});

test('leaves a trailing sentence period outside the path', () => {
  assert.deepEqual(splitMarkdownPaths('See out/review_D_tail.md.'), [
    { type: 'text', value: 'See ' },
    { type: 'path', value: 'out/review_D_tail.md' },
    { type: 'text', value: '.' },
  ]);
});

test('handles a deep path with underscores and hyphens', () => {
  const p = 'Assets/_Project/Docs/workstreams/vertical-slice/notes/deterministic-vs-agent-boundary.md';
  assert.deepEqual(splitMarkdownPaths(`The tier list is ${p}.`), [
    { type: 'text', value: 'The tier list is ' },
    { type: 'path', value: p },
    { type: 'text', value: '.' },
  ]);
});

test('handles backslash separators', () => {
  assert.deepEqual(splitMarkdownPaths('open docs\\notes\\plan.md now'), [
    { type: 'text', value: 'open ' },
    { type: 'path', value: 'docs\\notes\\plan.md' },
    { type: 'text', value: ' now' },
  ]);
});

test('finds several paths in one string', () => {
  const parts = splitMarkdownPaths('compare a/one.md against b/two.md today');
  assert.deepEqual(parts.filter((p) => p.type === 'path').map((p) => p.value), [
    'a/one.md', 'b/two.md',
  ]);
});

test('ignores a bare filename with no directory', () => {
  // Bare names are ambiguous and the protocol now forbids them, so they must
  // not render as links that would only fail on click.
  assert.deepEqual(splitMarkdownPaths('see STATE.md for detail'), [
    { type: 'text', value: 'see STATE.md for detail' },
  ]);
});

test('does not match a .mdx extension', () => {
  assert.deepEqual(splitMarkdownPaths('docs/page.mdx is not markdown'), [
    { type: 'text', value: 'docs/page.mdx is not markdown' },
  ]);
});

test('matches an uppercase extension', () => {
  const parts = splitMarkdownPaths('open docs/SHOUT.MD');
  assert.deepEqual(parts.filter((p) => p.type === 'path').map((p) => p.value), ['docs/SHOUT.MD']);
});

test('tolerates a non-string input', () => {
  assert.deepEqual(splitMarkdownPaths(null), [{ type: 'text', value: '' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../public/linkify'`

- [ ] **Step 3: Write `public/linkify.js`**

```js
'use strict';

/* Splits prose into plain-text runs and markdown-path runs.
   Lives in its own file so it can be unit-tested under node while still
   loading as a plain browser global — the repo has no build step. */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Linkify = api;
}(typeof self !== 'undefined' ? self : this, function () {
  // A path is two or more segments joined by / or \, ending in .md.
  // Requiring a separator keeps bare filenames (STATE.md) out: the protocol
  // requires repo-relative paths, and a bare name could not be resolved.
  const MD_PATH_RE = /(?:[A-Za-z]:)?[\w.~-]+(?:[\\/][\w.~-]+)+\.md(?![\w])/gi;

  function splitMarkdownPaths(input) {
    const text = typeof input === 'string' ? input : '';
    const parts = [];
    let last = 0;
    let match;
    MD_PATH_RE.lastIndex = 0;
    while ((match = MD_PATH_RE.exec(text)) !== null) {
      if (match.index > last) {
        parts.push({ type: 'text', value: text.slice(last, match.index) });
      }
      parts.push({ type: 'path', value: match[0] });
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    if (parts.length === 0) parts.push({ type: 'text', value: '' });
    return parts;
  }

  return { splitMarkdownPaths };
}));
```

Note the `+` on the separator group: it requires at least one `/` or `\`, which is what makes the bare-filename test pass.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 10 new tests green.

- [ ] **Step 5: Load the script in `public/index.html`**

Immediately before the existing inline `<script>` that opens the app code, add:

```html
<script src="/linkify.js"></script>
```

- [ ] **Step 6: Serve the new file from `server.js`**

`server.js` currently serves only `index.html`. In the GET branch, after the `'/'` / `'/index.html'` line, add:

```js
      if (pathname === '/linkify.js') return serveStatic(res, path.join(__dirname, 'public', 'linkify.js'), 'application/javascript; charset=utf-8');
```

And add this helper beside `serveIndex`:

```js
function serveStatic(res, filePath, contentType) {
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch (err) {
    return sendJson(res, 404, { error: `not found: ${path.basename(filePath)}` });
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
```

- [ ] **Step 7: Add the renderer helper in `public/index.html`**

Beside the `h()` helper (around `index.html:590`), add:

```js
/* Renders agent text as DOM nodes, turning markdown paths into links.
   Returns an array of nodes — never an HTML string, per the invariant above. */
function linkedText(str, requestId) {
  return Linkify.splitMarkdownPaths(str).map((part) => {
    if (part.type === 'text') return document.createTextNode(part.value);
    return h('a', {
      class: 'md-link',
      href: '#',
      title: `Open ${part.value} in Sublime Text and render it`,
      onclick: (ev) => {
        ev.preventDefault();
        openMarkdown(requestId, part.value, ev.currentTarget);
      },
    }, part.value);
  });
}

async function openMarkdown(requestId, filePath, anchor) {
  const previous = anchor.textContent;
  anchor.classList.add('busy');
  try {
    const res = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: requestId, path: filePath }),
    });
    if (!res.ok) {
      let message = `Opening ${filePath} failed (${res.status})`;
      try {
        const parsed = await res.json();
        if (parsed && parsed.error) message = parsed.error;
      } catch (_) { /* keep the status-code message */ }
      anchor.textContent = `${previous} — ${message}`;
      anchor.classList.add('failed');
    }
  } catch (err) {
    anchor.textContent = `${previous} — could not reach the inbox server`;
    anchor.classList.add('failed');
  } finally {
    anchor.classList.remove('busy');
  }
}
```

- [ ] **Step 8: Add link styling**

In the `<style>` block, beside the other rules:

```css
  .md-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    word-break: break-all;
  }
  .md-link:hover { text-decoration-thickness: 2px; }
  .md-link.busy { opacity: .6; cursor: progress; }
  .md-link.failed { color: var(--red); text-decoration-style: wavy; }
```

- [ ] **Step 9: Wire the four rendered fields**

`ask` at `index.html:1172` — replace:

```js
    h('div', { class: 'ask-text' }, req.ask || '(no ask text)'),
```

with:

```js
    h('div', { class: 'ask-text' }, ...linkedText(req.ask || '(no ask text)', req.id)),
```

`bulletSection` (used at `index.html:1174-1175` for `background` and `on_answered`) — change its list-item mapping from `h('li', {}, String(s))` to `h('li', {}, ...linkedText(String(s), requestId))`, threading a `requestId` argument through from both call sites.

`technical_context` at `index.html:1050` — replace:

```js
      h('ul', {}, req.technical_context.map((s) => h('li', {}, String(s)))),
```

with:

```js
      h('ul', {}, req.technical_context.map((s) => h('li', {}, ...linkedText(String(s), req.id)))),
```

- [ ] **Step 10: Verify in the browser**

Start the server, open `http://127.0.0.1:7717`, and check the card "Mark the 63 studios whose payment setup is not the standard one". `out/review_report.md` should be underlined. Click it: Sublime opens the file and Edge renders it.

- [ ] **Step 11: Commit**

```bash
git add public/linkify.js public/index.html server.js test/linkify.test.js
git commit -m "Render markdown paths in cards as clickable links"
```

---

### Task 5: Protocol and documentation

**Files:**
- Modify: `protocol/PROTOCOL.md`, `skill/agent-inbox/SKILL.md`, `README.md`

- [ ] **Step 1: Read the current wording**

Run: `grep -n "plain language\|filename\|file path" protocol/PROTOCOL.md skill/agent-inbox/SKILL.md`

Read enough surrounding context to match each document's voice before editing.

- [ ] **Step 2: Add the file-reference rule to `protocol/PROTOCOL.md`**

Add to the section covering how request text is written:

```markdown
### Referring to files

Write a **repo-relative path**, not a bare filename:

- Good: `Assets/_Project/Docs/workstreams/vertical-slice/PLAN.md`
- Bad: `PLAN.md` — the reader would have to search for it
- Bad: `[the plan](…/PLAN.md)` — card text is plain prose, not markdown

Paths are relative to the `repo` recorded for the card's project in
`projects.json`. Forward and backslashes both work. Markdown paths written this
way become clickable in the inbox: one click opens the file in the editor and
renders it. A path the inbox cannot resolve reports the failure on click, so
check the path before filing.

Every project a card is filed against must be registered in `projects.json`
with a `repo`. An unregistered project has no root to resolve against.
```

- [ ] **Step 3: Mirror the rule into `skill/agent-inbox/SKILL.md`**

Add the same guidance, condensed to three or four lines, wherever the skill describes writing request text. Agents read the skill, not the protocol, so this cannot be skipped.

- [ ] **Step 4: Document the environment variable in `README.md`**

Add to the environment-override table beside `AGENT_INBOX_PORT` and `AGENT_INBOX_DATA_DIR`:

```markdown
| `AGENT_INBOX_SUBL` | `C:\Program Files\Sublime Text\subl.exe` | Editor used to open and render markdown links |
```

Note in the same section that rendering relies on Sublime's MarkdownPreview package being installed.

- [ ] **Step 5: Commit**

```bash
git add protocol/PROTOCOL.md skill/agent-inbox/SKILL.md README.md
git commit -m "Document repo-relative file references"
```

---

### Task 6: Full verification

**Files:** none modified

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: every test passes, including the pre-existing `store.test.js` and `setup.test.js`.

- [ ] **Step 2: Warm-start check**

With Sublime already open, click a card link. Expected: the file opens and Edge renders it within about a second.

- [ ] **Step 3: Cold-start check**

Close Sublime completely — confirm with `tasklist /FI "IMAGENAME eq sublime_text.exe"` showing no match. Click a card link. Expected: Sublime launches, and the rendered preview still appears in Edge without a second click. This is the path that could not be verified during design.

- [ ] **Step 4: Failure-path check**

In `projects.json`, temporarily rename the `example-notes` key, reload the inbox, and click one of its links. Expected: the link text gains a readable error naming the unregistered project, and nothing launches. Restore the key afterwards.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues found in verification"
```
