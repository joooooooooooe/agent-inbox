'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const documents = require('../lib/documents');
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
  const abs = documents.resolveMarkdownPath(dataDir, 'req-1', 'docs/note.md');
  assert.equal(abs, path.join(repo, 'docs', 'note.md'));
});

test('resolves a repo-relative path with backslashes', () => {
  const { dataDir, repo } = fixture();
  const abs = documents.resolveMarkdownPath(dataDir, 'req-1', 'docs\\note.md');
  assert.equal(abs, path.join(repo, 'docs', 'note.md'));
});

test('accepts an absolute path inside the repo', () => {
  const { dataDir, repo } = fixture();
  const abs = documents.resolveMarkdownPath(dataDir, 'req-1', path.join(repo, 'docs', 'note.md'));
  assert.equal(abs, path.join(repo, 'docs', 'note.md'));
});

test('rejects traversal above the repo root', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => documents.resolveMarkdownPath(dataDir, 'req-1', '../../secrets.md'),
    'VALIDATION',
  );
});

test('rejects a sibling directory sharing the repo name prefix', () => {
  const { dataDir, repo } = fixture();
  const evil = `${repo}-evil`;
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'note.md'), '# evil\n', 'utf8');
  expectStoreError(
    () => documents.resolveMarkdownPath(dataDir, 'req-1', path.join(evil, 'note.md')),
    'VALIDATION',
  );
});

test('rejects a non-markdown extension', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => documents.resolveMarkdownPath(dataDir, 'req-1', 'docs/data.txt'),
    'VALIDATION',
  );
});

test('accepts an uppercase .MD extension', () => {
  const { dataDir, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'docs', 'SHOUT.MD'), '# shout\n', 'utf8');
  const abs = documents.resolveMarkdownPath(dataDir, 'req-1', 'docs/SHOUT.MD');
  assert.equal(abs, path.join(repo, 'docs', 'SHOUT.MD'));
});

test('rejects a markdown path that does not exist', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => documents.resolveMarkdownPath(dataDir, 'req-1', 'docs/missing.md'),
    'NOT_FOUND',
  );
});

test('rejects a directory even when it ends in .md', () => {
  const { dataDir, repo } = fixture();
  fs.mkdirSync(path.join(repo, 'docs', 'folder.md'), { recursive: true });
  expectStoreError(
    () => documents.resolveMarkdownPath(dataDir, 'req-1', 'docs/folder.md'),
    'VALIDATION',
  );
});

test('rejects a project missing from the registry', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => documents.resolveMarkdownPath(dataDir, 'req-orphan', 'docs/note.md'),
    'NOT_FOUND',
  );
});

test('rejects an unknown request id', () => {
  const { dataDir } = fixture();
  expectStoreError(
    () => documents.resolveMarkdownPath(dataDir, 'req-nope', 'docs/note.md'),
    'NOT_FOUND',
  );
});

test('rejects an empty path', () => {
  const { dataDir } = fixture();
  expectStoreError(() => documents.resolveMarkdownPath(dataDir, 'req-1', '  '), 'VALIDATION');
});

// --- reading ------------------------------------------------------------

test('reads a resolved document and returns its text', () => {
  const { dataDir, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), '# Title\n\nBody text.\n');
  const result = documents.readMarkdown(dataDir, 'req-1', 'docs/note.md');
  assert.equal(result.path, path.join(repo, 'docs', 'note.md'));
  assert.match(result.markdown, /# Title/);
});

test('reading applies the same boundary as resolving', () => {
  const { dataDir } = fixture();
  assert.throws(
    () => documents.readMarkdown(dataDir, 'req-1', '../../secrets.md'),
    (err) => err instanceof store.StoreError && err.httpStatus === 400,
  );
});

test('a byte-order mark is stripped rather than rendered', () => {
  const { dataDir, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), '﻿# Title\n');
  const result = documents.readMarkdown(dataDir, 'req-1', 'docs/note.md');
  assert.equal(result.markdown[0], '#');
});

test('a file over the size cap is refused with an explanation', () => {
  const { dataDir, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'docs', 'huge.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.throws(
    () => documents.readMarkdown(dataDir, 'req-1', 'docs/huge.md'),
    (err) => err instanceof store.StoreError && /limit for viewing/.test(err.message),
  );
});
