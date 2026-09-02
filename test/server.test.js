'use strict';

// HTTP-layer tests. lib/store is covered exhaustively in store.test.js; this
// suite is about the parts only server.js has: the Host gate, the
// Content-Type gate, the body cap, the path-traversal gate on request ids,
// and the route table.
//
// The server is started as a real child process against a temp data dir,
// because server.js reads its configuration once at require time. That also
// means these tests exercise the same code path a user runs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

let dataDir;
let repoDir;
let child;
let port;

// Random high port: server.js treats 0 as "unset" (Number(x) || 7717), so an
// ephemeral port is not an option here.
function randomPort() {
  return 20000 + Math.floor(Math.random() * 30000);
}

function startServer(dir, attempt = 0) {
  return new Promise((resolve, reject) => {
    const chosen = randomPort();
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, AGENT_INBOX_DATA_DIR: dir, AGENT_INBOX_PORT: String(chosen) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (buf) => {
      out += buf.toString();
      if (out.includes('listening on')) {
        proc.stdout.off('data', onData);
        resolve({ proc, port: chosen });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (buf) => {
      const text = buf.toString();
      if (text.includes('already running') && attempt < 5) {
        // Lost a race for the port; try another one.
        try { proc.kill(); } catch (_) { /* already gone */ }
        resolve(startServer(dir, attempt + 1));
      }
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`server did not start; output was: ${out}`)), 10000).unref();
  });
}

// fetch with an explicit Host header, which is the whole point of several of
// these tests. undici forbids setting Host, so this is a raw socket request.
function rawRequest({ method = 'GET', pathname = '/', host, contentType, body }) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (contentType) headers['Content-Type'] = contentType;
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(
      // agent:false — no connection reuse. The body-cap test makes the server
      // destroy its socket, and a pooled connection would then hand the next
      // test an ECONNRESET that has nothing to do with what it is checking.
      { host: '127.0.0.1', port, path: pathname, method, headers, setHost: !host, agent: false },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not every route is JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postJson = (pathname, obj, opts = {}) => rawRequest({
  method: 'POST',
  pathname,
  contentType: 'application/json',
  body: JSON.stringify(obj),
  ...opts,
});

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-servertest-'));
  fs.mkdirSync(path.join(dataDir, 'requests'), { recursive: true });
  repoDir = path.join(dataDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'docs', 'note.md'),
    '# A design note\n\nWith a **point** to make.\n',
  );
  fs.writeFileSync(path.join(repoDir, 'secret.txt'), 'not markdown');
  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify({ schema_version: 1, projects: { demo: { name: 'Demo', repo: repoDir } } }, null, 2),
  );
  const started = await startServer(dataDir);
  child = started.proc;
  port = started.port;
});

test.after(() => {
  try { child.kill(); } catch (_) { /* already exited */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Host gate — the DNS-rebinding boundary
// ---------------------------------------------------------------------------

test('GET /api/state is refused when the Host header is not the loopback origin', async () => {
  // Binding 127.0.0.1 does not stop DNS rebinding: an attacker's page can be
  // made same-origin with the inbox. Host is the header a browser will not let
  // that page forge, so reads must check it too — not just writes.
  const res = await rawRequest({ pathname: '/api/state', host: 'evil.example.com' });
  assert.strictEqual(res.status, 403);
  assert.match(res.json.error, /Host/);
});

test('GET /api/state is allowed from 127.0.0.1 and from localhost', async () => {
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const res = await rawRequest({ pathname: '/api/state', host });
    assert.strictEqual(res.status, 200, `host ${host} should be allowed`);
    assert.ok(Array.isArray(res.json.requests));
    assert.ok(res.json.projects && res.json.projects.projects);
  }
});

test('POST is refused when the Host header is not the loopback origin', async () => {
  const res = await postJson('/api/requests', { project: 'demo' }, { host: 'evil.example.com' });
  assert.strictEqual(res.status, 403);
});

test('a Host header for the right name but the wrong port is refused', async () => {
  const res = await rawRequest({ pathname: '/api/state', host: `127.0.0.1:${port + 1}` });
  assert.strictEqual(res.status, 403);
});

// ---------------------------------------------------------------------------
// Request gates
// ---------------------------------------------------------------------------

test('POST without a JSON Content-Type is refused', async () => {
  const res = await rawRequest({
    method: 'POST',
    pathname: '/api/requests',
    contentType: 'text/plain',
    body: '{}',
  });
  assert.strictEqual(res.status, 415);
});

test('POST with a JSON Content-Type plus charset is accepted', async () => {
  const res = await rawRequest({
    method: 'POST',
    pathname: '/api/requests',
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({}),
  });
  assert.strictEqual(res.status, 400); // reached validation, which is the point
});

test('POST with a body that is not JSON is a 400, not a crash', async () => {
  const res = await rawRequest({
    method: 'POST',
    pathname: '/api/requests',
    contentType: 'application/json',
    body: 'not json at all',
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /not valid JSON/);
});

test('POST with a JSON array body is refused', async () => {
  const res = await postJson('/api/requests', [1, 2, 3]);
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /must be a JSON object/);
});

test('a body over 1 MB is refused with 413', async () => {
  const res = await rawRequest({
    method: 'POST',
    pathname: '/api/requests',
    contentType: 'application/json',
    body: JSON.stringify({ project: 'demo', pad: 'x'.repeat(1024 * 1024 + 64) }),
  });
  assert.strictEqual(res.status, 413);
});

test('a traversal attempt in a request id is rejected before any file access', async () => {
  // Percent-encoded, because that is the only way these reach the route at
  // all — a raw space would not survive the request line.
  for (const id of ['..%2F..%2Fsecrets', '..', 'a%2F..%2Fb', 'has%20spaces', 'semi%3Bcolon', '%2Fetc%2Fpasswd']) {
    const res = await postJson(`/api/requests/${id}/answer`, { value: 'x' });
    assert.strictEqual(res.status, 400, `id "${id}" should be rejected`);
    assert.match(res.json.error, /invalid request id|not found/);
  }
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('GET / serves the app shell', async () => {
  const res = await rawRequest({ pathname: '/' });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<title>Agent Inbox<\/title>/);
});

test('GET /linkify.js serves the one static script the page needs', async () => {
  const res = await rawRequest({ pathname: '/linkify.js' });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /splitMarkdownPaths/);
});

test('unknown routes are 404, under /api/ and outside it', async () => {
  for (const pathname of ['/nope', '/api/nope', '/api/requests/x/nope']) {
    const res = await rawRequest({ pathname });
    assert.strictEqual(res.status, 404, `${pathname} should be 404`);
  }
});

test('a GET to a POST-only route is a 404 rather than an action', async () => {
  const res = await rawRequest({ pathname: '/api/requests' });
  assert.strictEqual(res.status, 404);
});

// ---------------------------------------------------------------------------
// End-to-end through HTTP
// ---------------------------------------------------------------------------

test('create, answer, and archive a request over HTTP', async () => {
  const created = await postJson('/api/requests', {
    project: 'demo',
    agent: 'test',
    title: 'Pick a colour',
    ask: 'Which colour should the banner be?',
    response: {
      type: 'choice',
      options: [{ key: 'red', label: 'Red' }, { key: 'blue', label: 'Blue' }],
    },
  });
  assert.strictEqual(created.status, 201);
  const { id } = created.json.request;
  assert.ok(fs.existsSync(path.join(dataDir, 'requests', `${id}.json`)));

  // An answer the request's own options do not allow is a 400.
  const bogus = await postJson(`/api/requests/${id}/answer`, { value: 'green' });
  assert.strictEqual(bogus.status, 400);

  const answered = await postJson(`/api/requests/${id}/answer`, { value: 'red', notes: 'warmer' });
  assert.strictEqual(answered.status, 200);
  assert.strictEqual(answered.json.request.status, 'answered');
  assert.strictEqual(answered.json.request.answer.value, 'red');

  // The digest an agent actually reads is written as part of answering.
  const digest = fs.readFileSync(path.join(dataDir, 'answers', 'demo.md'), 'utf8');
  assert.match(digest, /Pick a colour/);
  assert.match(digest, /Red/);

  // Answering twice needs force, otherwise it is a conflict.
  const again = await postJson(`/api/requests/${id}/answer`, { value: 'blue' });
  assert.strictEqual(again.status, 409);
  const forced = await postJson(`/api/requests/${id}/answer`, { value: 'blue', force: true });
  assert.strictEqual(forced.status, 200);

  const archived = await postJson(`/api/requests/${id}/archive`, {});
  assert.strictEqual(archived.status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'requests', 'archive', `${id}.json`)));
  assert.ok(!fs.existsSync(path.join(dataDir, 'requests', `${id}.json`)));
});

test('answering a request that does not exist is a 404', async () => {
  const res = await postJson('/api/requests/20260101-demo-nope-ffff/answer', { value: 'x' });
  assert.strictEqual(res.status, 404);
});

test('returning a request for rewrite requires a reason', async () => {
  const created = await postJson('/api/requests', {
    project: 'demo',
    title: 'Jargon heavy',
    ask: 'Blocked on the §3.5 exception in src/core/params.ts.',
    response: { type: 'approval' },
  });
  const { id } = created.json.request;

  const noReason = await postJson(`/api/requests/${id}/status`, { status: 'returned' });
  assert.strictEqual(noReason.status, 400);

  const returned = await postJson(`/api/requests/${id}/status`, {
    status: 'returned',
    returned_reason: 'Please rewrite this without the file path or the section reference.',
  });
  assert.strictEqual(returned.status, 200);
  assert.strictEqual(returned.json.request.status, 'returned');

  // Only settled requests can be archived; a returned one is still in flight.
  const archived = await postJson(`/api/requests/${id}/archive`, {});
  assert.strictEqual(archived.status, 409);
});

test('the clarity lint reaches the client through /api/state', async () => {
  const res = await rawRequest({ pathname: '/api/state' });
  const jargon = res.json.requests.find((r) => r.title === 'Jargon heavy');
  assert.ok(jargon, 'the jargon-heavy request should be listed');
  assert.ok(jargon.clarity_warnings.length > 0, 'it should carry clarity warnings');
});

// ---------------------------------------------------------------------------
// Reading documents a card links to
// ---------------------------------------------------------------------------

test('a document inside the project repo is read and returned', async () => {
  const created = await postJson('/api/requests', {
    project: 'demo',
    title: 'Points at a doc',
    ask: 'See docs/note.md — should we do what it says?',
    response: { type: 'approval' },
  });
  const { id } = created.json.request;

  const res = await postJson('/api/file', { id, path: 'docs/note.md' });
  assert.strictEqual(res.status, 200);
  assert.match(res.json.markdown, /# A design note/);
  assert.strictEqual(res.json.path, path.join(repoDir, 'docs', 'note.md'));
  // No editor is configured in the test environment, so the app knows not to
  // offer to launch one.
  assert.strictEqual(res.json.editor, null);
});

test('reading refuses to escape the project repo, or to read non-markdown', async () => {
  const created = await postJson('/api/requests', {
    project: 'demo',
    title: 'Points at a doc',
    ask: 'Anything.',
    response: { type: 'approval' },
  });
  const { id } = created.json.request;

  for (const bad of ['../../../../etc/passwd', '../secrets.md', 'secret.txt', 'docs/missing.md']) {
    const res = await postJson('/api/file', { id, path: bad });
    assert.ok(res.status === 400 || res.status === 404, `"${bad}" must be refused, got ${res.status}`);
  }
});

test('launching an external editor is refused when none is configured', async () => {
  // The server spawns nothing unless AGENT_INBOX_OPEN_CMD names a program,
  // so the default posture of a fresh clone is "no process launching at all".
  const created = await postJson('/api/requests', {
    project: 'demo',
    title: 'Points at a doc',
    ask: 'Anything.',
    response: { type: 'approval' },
  });
  const { id } = created.json.request;

  const res = await postJson('/api/open', { id, path: 'docs/note.md' });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /AGENT_INBOX_OPEN_CMD/);
});

test('GET /markdown.js serves the renderer the page needs', async () => {
  const res = await rawRequest({ pathname: '/markdown.js' });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /parseInline/);
});
