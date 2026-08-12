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
