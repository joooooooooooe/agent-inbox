'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('../lib/store');

const tmpDirs = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-test-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // best effort
    }
  }
});

function writeProjects(dataDir, projects) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify({ schema_version: 1, projects }, null, 2),
    'utf8',
  );
}

function noTmpResidue(dataDir) {
  const leftovers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) leftovers.push(full);
    }
  };
  walk(dataDir);
  return leftovers;
}

const CHOICE_INPUT = {
  project: 'myproject',
  agent: 'claude-code',
  title: 'Choose storage format',
  ask: 'Markdown or JSON?',
  background: ['We need durable answers.'],
  urgency: 'high',
  blocking: true,
  response: {
    type: 'choice',
    options: [
      { key: 'md', label: 'Markdown file' },
      { key: 'json', label: 'Structured JSON' },
    ],
  },
  on_answered: ['Will write the chosen format.'],
};

// ---------------------------------------------------------------------------
// ensureStore
// ---------------------------------------------------------------------------

test('ensureStore seeds dirs, projects.json and syncs PROTOCOL.md', () => {
  const dataDir = path.join(makeTmp(), 'store');
  const protoSrc = path.join(makeTmp(), 'PROTOCOL.md');
  fs.writeFileSync(protoSrc, '# protocol v1\n', 'utf8');

  const first = store.ensureStore(dataDir, protoSrc);
  assert.equal(first.created, true);
  assert.equal(first.protocolSynced, true);
  assert.ok(fs.statSync(path.join(dataDir, 'requests')).isDirectory());
  assert.ok(fs.statSync(path.join(dataDir, 'answers')).isDirectory());
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')),
    { schema_version: 1, projects: {} },
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'PROTOCOL.md'), 'utf8'), '# protocol v1\n');

  // Same content => no re-sync.
  const second = store.ensureStore(dataDir, protoSrc);
  assert.equal(second.created, false);
  assert.equal(second.protocolSynced, false);

  // Data-dir copy drifted => repo copy wins.
  fs.writeFileSync(path.join(dataDir, 'PROTOCOL.md'), 'tampered', 'utf8');
  const third = store.ensureStore(dataDir, protoSrc);
  assert.equal(third.protocolSynced, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'PROTOCOL.md'), 'utf8'), '# protocol v1\n');
  assert.deepEqual(noTmpResidue(dataDir), []);
});

test('ensureStore renders {{DATA_DIR}} tokens in PROTOCOL.md for this machine', () => {
  const dataDir = path.join(makeTmp(), 'store');
  const protoSrc = path.join(makeTmp(), 'PROTOCOL.md');
  fs.writeFileSync(protoSrc,
    '# protocol\nFile requests in `{{DATA_DIR}}/requests/`.\nRegistry: {{DATA_DIR}}/projects.json\n',
    'utf8');

  const first = store.ensureStore(dataDir, protoSrc);
  assert.equal(first.protocolSynced, true);
  const synced = fs.readFileSync(path.join(dataDir, 'PROTOCOL.md'), 'utf8');
  const rendered = dataDir.replace(/\\/g, '/');
  assert.ok(!synced.includes('{{DATA_DIR}}'), 'no unrendered tokens may remain');
  assert.ok(synced.includes(`${rendered}/requests/`), 'token became the real data dir');
  assert.ok(synced.includes(`${rendered}/projects.json`));

  // Idempotent per machine: rendered copy is already current on the next boot.
  const second = store.ensureStore(dataDir, protoSrc);
  assert.equal(second.protocolSynced, false);

  // Tampered copy is still re-rendered from the repo source.
  fs.writeFileSync(path.join(dataDir, 'PROTOCOL.md'), 'tampered', 'utf8');
  const third = store.ensureStore(dataDir, protoSrc);
  assert.equal(third.protocolSynced, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'PROTOCOL.md'), 'utf8'), synced);
});

test('ensureStore regenerates digests for all projects on boot', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  writeProjects(dataDir, { alpha: { name: 'Alpha', repo: 'C:\\nope' } });
  const req = store.createRequest(dataDir, { ...CHOICE_INPUT, project: 'beta' });
  store.answerRequest(dataDir, req.id, { value: 'md' });
  // Wipe digests, then boot again.
  fs.rmSync(path.join(dataDir, 'answers'), { recursive: true, force: true });
  store.ensureStore(dataDir, null);
  assert.ok(fs.existsSync(path.join(dataDir, 'answers', 'alpha.md')));
  const beta = fs.readFileSync(path.join(dataDir, 'answers', 'beta.md'), 'utf8');
  assert.match(beta, /Choose storage format/);
});

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

test('validateId rejects traversal and junk, accepts real ids', () => {
  assert.equal(store.validateId('20260807-myproject-choose-storage-a1b2'), true);
  assert.equal(store.validateId('../evil'), false);
  assert.equal(store.validateId('..'), false);
  assert.equal(store.validateId('a/b'), false);
  assert.equal(store.validateId('a\\b'), false);
  assert.equal(store.validateId(''), false);
  assert.equal(store.validateId('a'.repeat(201)), false);
  assert.equal(store.validateId('a'.repeat(200)), true);
  assert.equal(store.validateId(null), false);
  assert.equal(store.validateId('has space'), false);
});

test('generateId format: date, project, kebab title, 4 hex', () => {
  const now = new Date('2026-08-07T18:00:00Z');
  const id = store.generateId('myproject', 'Choose Storage: Format!!', now);
  assert.match(id, /^20260807-myproject-choose-storage-format-[0-9a-f]{4}$/);
  const long = store.generateId('p', 'x'.repeat(100), now);
  assert.match(long, /^20260807-p-x{40}-[0-9a-f]{4}$/);
  const symbols = store.generateId('p', '!!!', now);
  assert.match(symbols, /^20260807-p-request-[0-9a-f]{4}$/);
});

test('readRequest / mutations reject bad ids before touching the fs', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  for (const bad of ['../evil', 'a/b', '', '..', 'a b']) {
    assert.throws(() => store.readRequest(dataDir, bad), (e) => e.code === 'VALIDATION');
    assert.throws(() => store.answerRequest(dataDir, bad, { value: 'x' }), (e) => e.code === 'VALIDATION');
    assert.throws(() => store.setStatus(dataDir, bad, { status: 'withdrawn' }), (e) => e.code === 'VALIDATION');
  }
  assert.throws(() => store.readRequest(dataDir, 'no-such-id'), (e) => e.code === 'NOT_FOUND' && e.httpStatus === 404);
});

// ---------------------------------------------------------------------------
// create + list
// ---------------------------------------------------------------------------

test('createRequest fills defaults, preserves extras, lists back', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const created = store.createRequest(dataDir, {
    project: 'demo',
    title: 'Pick a name',
    ask: 'What should we call it?',
    response: { type: 'text' },
    custom_field: { nested: true },
  });
  assert.equal(created.schema_version, 1);
  assert.equal(created.status, 'open');
  assert.equal(created.answer, null);
  assert.equal(created.superseded_by, null);
  assert.equal(created.agent, 'human');
  assert.equal(created.urgency, 'medium');
  assert.equal(created.blocking, false);
  assert.deepEqual(created.background, []);
  assert.deepEqual(created.custom_field, { nested: true });
  assert.match(created.created, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  const { requests, invalid } = store.listRequests(dataDir);
  assert.equal(invalid.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, created.id);
  assert.equal(requests[0].custom_field.nested, true);
  assert.deepEqual(noTmpResidue(dataDir), []);
});

test('createRequest validation failures', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const cases = [
    [{ ...CHOICE_INPUT, project: 'Bad Slug' }, /project/],
    [{ ...CHOICE_INPUT, project: undefined }, /project/],
    [{ ...CHOICE_INPUT, title: '  ' }, /title/],
    [{ ...CHOICE_INPUT, ask: '' }, /ask/],
    [{ ...CHOICE_INPUT, response: { type: 'nope' } }, /response.type/],
    [{ ...CHOICE_INPUT, response: { type: 'choice' } }, /options/],
    [{ ...CHOICE_INPUT, response: { type: 'choice', options: [] } }, /options/],
    [{ ...CHOICE_INPUT, response: { type: 'choice', options: [{ key: 'a' }, { key: 'a' }] } }, /duplicate/],
    [{ ...CHOICE_INPUT, urgency: 'urgent' }, /urgency/],
    [{ ...CHOICE_INPUT, blocking: 'yes' }, /blocking/],
    [{ ...CHOICE_INPUT, background: 'not-an-array' }, /background/],
  ];
  for (const [input, re] of cases) {
    assert.throws(
      () => store.createRequest(dataDir, input),
      (e) => e.code === 'VALIDATION' && e.httpStatus === 400 && re.test(e.message),
      `expected rejection for ${JSON.stringify(input).slice(0, 80)}`,
    );
  }
  assert.equal(store.listRequests(dataDir).requests.length, 0);
});

// ---------------------------------------------------------------------------
// answer round-trips, all 5 types
// ---------------------------------------------------------------------------

test('answer round-trip: choice', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const req = store.createRequest(dataDir, CHOICE_INPUT);
  const { request, mirror_warnings } = store.answerRequest(dataDir, req.id, {
    value: 'json',
    notes: 'JSON is greppable.',
  });
  assert.equal(request.status, 'answered');
  assert.equal(request.answer.value, 'json');
  assert.equal(request.answer.notes, 'JSON is greppable.');
  assert.match(request.answer.answered_at, /Z$/);
  assert.deepEqual(mirror_warnings, []); // project unregistered => no mirror, no warning
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'requests', `${req.id}.json`), 'utf8'),
  );
  assert.equal(onDisk.status, 'answered');
  assert.equal(onDisk.answer.value, 'json');
});

test('answer round-trip: multi_select, text, checklist, approval', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const base = { project: 'demo', title: 'T', ask: 'A?' };
  const opts = { options: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }] };

  const multi = store.createRequest(dataDir, { ...base, response: { type: 'multi_select', ...opts } });
  assert.deepEqual(store.answerRequest(dataDir, multi.id, { value: ['a', 'b'] }).request.answer.value, ['a', 'b']);

  const text = store.createRequest(dataDir, { ...base, response: { type: 'text' } });
  assert.equal(store.answerRequest(dataDir, text.id, { value: 'call it Fred' }).request.answer.value, 'call it Fred');

  const checklist = store.createRequest(dataDir, { ...base, response: { type: 'checklist', ...opts } });
  assert.deepEqual(store.answerRequest(dataDir, checklist.id, { value: [] }).request.answer.value, []); // empty allowed

  const approval = store.createRequest(dataDir, { ...base, response: { type: 'approval' } });
  const ans = store.answerRequest(dataDir, approval.id, {
    value: { decision: 'approve', scope: 'phase-1' },
    notes: 'approve with notes',
  }).request.answer;
  assert.equal(ans.value.decision, 'approve');
  assert.equal(ans.value.scope, 'phase-1'); // extra keys preserved
  assert.equal(ans.notes, 'approve with notes');
});

test('validateAnswerShape rejections per type', () => {
  const opts = { options: [{ key: 'a' }, { key: 'b' }] };
  const bad = [
    [{ type: 'choice', ...opts }, 'z'],
    [{ type: 'choice', ...opts }, ['a']],
    [{ type: 'choice', options: [] }, 'a'],
    [{ type: 'multi_select', ...opts }, 'a'],
    [{ type: 'multi_select', ...opts }, ['a', 'z']],
    [{ type: 'multi_select', ...opts }, ['a', 'a']],
    [{ type: 'checklist', ...opts }, [1]],
    [{ type: 'text' }, ''],
    [{ type: 'text' }, '   '],
    [{ type: 'text' }, 42],
    [{ type: 'approval' }, { decision: 'maybe' }],
    [{ type: 'approval' }, 'approve'],
    [{ type: 'mystery' }, 'x'],
  ];
  for (const [response, value] of bad) {
    assert.throws(
      () => store.validateAnswerShape(response, value),
      (e) => e.code === 'VALIDATION',
      `expected rejection for type=${response.type} value=${JSON.stringify(value)}`,
    );
  }
  // sanity: valid shapes pass
  store.validateAnswerShape({ type: 'choice', ...opts }, 'a');
  store.validateAnswerShape({ type: 'multi_select', ...opts }, []);
  store.validateAnswerShape({ type: 'approval' }, { decision: 'reject' });
});

test('answering a non-open request: 409 without force, succeeds with force', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const req = store.createRequest(dataDir, CHOICE_INPUT);
  store.answerRequest(dataDir, req.id, { value: 'md' });
  assert.throws(
    () => store.answerRequest(dataDir, req.id, { value: 'json' }),
    (e) => e.code === 'CONFLICT' && e.httpStatus === 409 && /answered/.test(e.message),
  );
  const forced = store.answerRequest(dataDir, req.id, { value: 'json', force: true });
  assert.equal(forced.request.answer.value, 'json');
});

test('read-modify-write preserves unknown fields and body id verbatim', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const id = 'agent-filed-0001';
  const filed = {
    schema_version: 1,
    id: 'body-id-that-differs', // mismatch tolerated; filename is canonical
    project: 'demo',
    agent: 'codex',
    title: 'Agent filed',
    ask: 'Yes?',
    response: { type: 'text' },
    status: 'open',
    answer: null,
    superseded_by: null,
    x_agent_metadata: { retries: 3 },
  };
  fs.writeFileSync(
    path.join(dataDir, 'requests', `${id}.json`),
    JSON.stringify(filed, null, 2),
    'utf8',
  );
  const listed = store.listRequests(dataDir).requests.find((r) => r.id === id);
  assert.ok(listed, 'canonical id comes from filename');

  const { request } = store.answerRequest(dataDir, id, { value: 'sure' });
  assert.equal(request.id, id);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'requests', `${id}.json`), 'utf8'));
  assert.equal(onDisk.id, 'body-id-that-differs'); // body preserved verbatim
  assert.deepEqual(onDisk.x_agent_metadata, { retries: 3 });
  assert.equal(onDisk.status, 'answered');
});

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

test('setStatus: reopen keeps prior answer; withdrawn; superseded with pointer', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const req = store.createRequest(dataDir, CHOICE_INPUT);
  store.answerRequest(dataDir, req.id, { value: 'md' });

  const reopened = store.setStatus(dataDir, req.id, { status: 'open' }).request;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.answer.value, 'md'); // history kept
  assert.equal(reopened.superseded_by, null);

  const withdrawn = store.setStatus(dataDir, req.id, { status: 'withdrawn' }).request;
  assert.equal(withdrawn.status, 'withdrawn');

  const superseded = store.setStatus(dataDir, req.id, {
    status: 'superseded',
    superseded_by: 'some-successor-id',
  }).request;
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.superseded_by, 'some-successor-id');

  assert.throws(
    () => store.setStatus(dataDir, req.id, { status: 'answered' }),
    (e) => e.code === 'VALIDATION',
  );
  assert.throws(
    () => store.setStatus(dataDir, req.id, { status: 'superseded', superseded_by: '../evil' }),
    (e) => e.code === 'VALIDATION',
  );
});

// ---------------------------------------------------------------------------
// atomic writes
// ---------------------------------------------------------------------------

test('atomicWriteFile: success leaves no temp files; failure keeps target intact', () => {
  const dir = makeTmp();
  const target = path.join(dir, 'out.txt');
  store.atomicWriteFile(target, 'hello');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  assert.deepEqual(fs.readdirSync(dir), ['out.txt']);

  // Failure mode: rename onto a path occupied by a DIRECTORY fails; the
  // existing entry must be intact and the temp file cleaned up.
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'inner.txt'), 'original', 'utf8');
  assert.throws(
    () => store.atomicWriteFile(blocked, 'clobber'),
    (e) => e instanceof store.StoreError && e.code === 'IO' && e.httpStatus === 500,
  );
  assert.equal(fs.readFileSync(path.join(blocked, 'inner.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['blocked', 'out.txt']);

  // Failure mode: missing parent directory.
  assert.throws(
    () => store.atomicWriteFile(path.join(dir, 'no-such-dir', 'x.txt'), 'y'),
    (e) => e.code === 'IO',
  );
});

// ---------------------------------------------------------------------------
// invalid-file tolerance
// ---------------------------------------------------------------------------

test('listRequests tolerates malformed files and reports them', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const reqDir = path.join(dataDir, 'requests');
  fs.writeFileSync(path.join(reqDir, 'broken-json.json'), '{ not json', 'utf8');
  fs.writeFileSync(path.join(reqDir, 'empty-file.json'), '', 'utf8');
  fs.writeFileSync(path.join(reqDir, 'not-object.json'), '[1,2,3]', 'utf8');
  fs.writeFileSync(
    path.join(reqDir, 'missing-fields.json'),
    JSON.stringify({ project: 'demo' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(reqDir, 'bad id!.json'),
    JSON.stringify({ project: 'demo', title: 't', response: { type: 'text' } }),
    'utf8',
  );
  fs.writeFileSync(path.join(reqDir, 'notes.txt'), 'ignored entirely', 'utf8');
  const good = store.createRequest(dataDir, CHOICE_INPUT);

  const { requests, invalid } = store.listRequests(dataDir);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, good.id);
  const files = invalid.map((i) => i.file).sort();
  assert.deepEqual(files, [
    'bad id!.json',
    'broken-json.json',
    'empty-file.json',
    'missing-fields.json',
    'not-object.json',
  ]);
  for (const entry of invalid) assert.equal(typeof entry.error, 'string');

  // Digests skip invalid files and don't crash.
  store.answerRequest(dataDir, good.id, { value: 'md' });
  const digest = fs.readFileSync(path.join(dataDir, 'answers', 'myproject.md'), 'utf8');
  assert.match(digest, /Choose storage format/);
});

test('request files with a UTF-8 BOM parse fine (PowerShell Set-Content writes one)', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const id = 'bom-filed-0001';
  const body = JSON.stringify({
    schema_version: 1, id, project: 'demo', agent: 'ps-agent', title: 'BOM file',
    ask: 'Parses?', response: { type: 'text' }, status: 'open', answer: null, superseded_by: null,
  }, null, 2);
  fs.writeFileSync(path.join(dataDir, 'requests', `${id}.json`), String.fromCharCode(0xfeff) + body, 'utf8');
  const { requests, invalid } = store.listRequests(dataDir);
  assert.equal(invalid.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, id);
  const { request } = store.answerRequest(dataDir, id, { value: 'yes' });
  assert.equal(request.status, 'answered');
});

test('getState reports corrupt projects.json without crashing', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '{oops', 'utf8');
  const state = store.getState(dataDir);
  assert.deepEqual(state.projects, { schema_version: 1, projects: {} });
  assert.ok(state.invalid.some((i) => i.file === 'projects.json'));
});

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

test('digest: content, label rendering, ordering, exclusions, superseded marking', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  writeProjects(dataDir, { demo: { name: 'Demo Project', repo: 'C:\\absent' } });

  const t0 = new Date('2026-08-01T10:00:00Z');
  const t1 = new Date('2026-08-05T10:00:00Z');
  const t2 = new Date('2026-08-07T10:00:00Z');
  const base = { project: 'demo', agent: 'claude-code', ask: 'Pick.' };
  const opts = { options: [{ key: 'md', label: 'Markdown file' }, { key: 'json', label: 'Structured JSON' }] };

  const older = store.createRequest(dataDir, { ...base, title: 'Older question', response: { type: 'choice', ...opts } }, t0);
  const newer = store.createRequest(dataDir, { ...base, title: 'Newer question', response: { type: 'multi_select', ...opts } }, t0);
  const open = store.createRequest(dataDir, { ...base, title: 'Still open', response: { type: 'text' } }, t0);
  const withdrawn = store.createRequest(dataDir, { ...base, title: 'Withdrawn one', response: { type: 'text' } }, t0);
  const superseded = store.createRequest(dataDir, { ...base, title: 'Superseded never answered', response: { type: 'text' } }, t0);

  store.answerRequest(dataDir, older.id, { value: 'md', notes: 'multi\nline note' }, t1);
  store.answerRequest(dataDir, newer.id, { value: ['md', 'json'] }, t2);
  store.setStatus(dataDir, withdrawn.id, { status: 'withdrawn' });
  store.setStatus(dataDir, superseded.id, { status: 'superseded', superseded_by: newer.id });

  const digest = fs.readFileSync(path.join(dataDir, 'answers', 'demo.md'), 'utf8');
  assert.match(digest, /^# Agent Inbox — answered requests for Demo Project/);
  assert.match(digest, /> Generated by Agent Inbox\. Do not edit; edits will be overwritten\./);
  assert.match(digest, /Machine-readable source of truth:/);

  // Ordering: newest answered first.
  const iNewer = digest.indexOf('Newer question');
  const iOlder = digest.indexOf('Older question');
  assert.ok(iNewer !== -1 && iOlder !== -1 && iNewer < iOlder, 'newest first');

  // Labels + joining; notes flattened to one line.
  assert.match(digest, /\*\*Answer:\*\* Markdown file, Structured JSON/);
  assert.match(digest, /\*\*Answer:\*\* Markdown file\n/);
  assert.match(digest, /\*\*Notes:\*\* multi line note/);
  assert.match(digest, /## 2026-08-07 — Newer question {2}\(id: /);

  // Exclusions + superseded marking.
  assert.ok(!digest.includes('Still open'));
  assert.ok(!digest.includes('Withdrawn one'));
  assert.match(digest, new RegExp(`\\*\\*Status:\\*\\* superseded — see ${newer.id}`));
  assert.match(digest, new RegExp(`\\(none — superseded by ${newer.id}\\)`));
  assert.ok(!digest.includes(open.id));
});

test('digest: approval rendering, empty digest still written, unregistered slug uses slug as name', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const req = store.createRequest(dataDir, {
    project: 'zeta', title: 'Ship it?', ask: 'OK to ship?', response: { type: 'approval' },
  });
  store.answerRequest(dataDir, req.id, { value: { decision: 'reject' } });
  const digest = fs.readFileSync(path.join(dataDir, 'answers', 'zeta.md'), 'utf8');
  assert.match(digest, /^# Agent Inbox — answered requests for zeta/);
  assert.match(digest, /\*\*Answer:\*\* Rejected/);

  const empty = store.generateDigest(dataDir, 'nothing-here');
  assert.ok(fs.existsSync(empty.path));
  assert.match(empty.markdown, /_No answered requests yet\._/);
  assert.match(empty.markdown, /Do not edit/);

  assert.throws(() => store.generateDigest(dataDir, '../evil'), (e) => e.code === 'VALIDATION');
});

test('reopened request drops out of the digest (answer kept as history)', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const req = store.createRequest(dataDir, CHOICE_INPUT);
  store.answerRequest(dataDir, req.id, { value: 'md' });
  store.setStatus(dataDir, req.id, { status: 'open' });
  const digest = fs.readFileSync(path.join(dataDir, 'answers', 'myproject.md'), 'utf8');
  assert.ok(!digest.includes(req.id));
  assert.match(digest, /_No answered requests yet\._/);
});

// ---------------------------------------------------------------------------
// mirror
// ---------------------------------------------------------------------------

test('mirror: happy path writes digest into repo, creating parent dirs', () => {
  const dataDir = makeTmp();
  const repo = makeTmp();
  store.ensureStore(dataDir, null);
  writeProjects(dataDir, {
    demo: { name: 'Demo', repo, mirror: 'dev/agent-answers.md' }, // forward slashes normalized
  });
  const req = store.createRequest(dataDir, { ...CHOICE_INPUT, project: 'demo' });
  const { mirror_warnings } = store.answerRequest(dataDir, req.id, { value: 'json' });
  assert.deepEqual(mirror_warnings, []);
  const mirrored = fs.readFileSync(path.join(repo, 'dev', 'agent-answers.md'), 'utf8');
  const digest = fs.readFileSync(path.join(dataDir, 'answers', 'demo.md'), 'utf8');
  assert.equal(mirrored, digest);
  assert.deepEqual(noTmpResidue(repo), []);
});

test('mirror: missing repo, escaping path, and no-mirror cases', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const repo = makeTmp();
  writeProjects(dataDir, {
    gone: { name: 'Gone', repo: path.join(repo, 'does-not-exist'), mirror: 'x.md' },
    sneaky: { name: 'Sneaky', repo, mirror: '..\\..\\evil.md' },
    plain: { name: 'Plain', repo }, // no mirror key
  });

  const w1 = store.mirrorDigest(dataDir, 'gone');
  assert.equal(w1.length, 1);
  assert.match(w1[0], /repo directory not found/);

  const w2 = store.mirrorDigest(dataDir, 'sneaky');
  assert.equal(w2.length, 1);
  assert.match(w2[0], /escapes the repo/);
  assert.ok(!fs.existsSync(path.join(path.dirname(repo), 'evil.md')));

  assert.deepEqual(store.mirrorDigest(dataDir, 'plain'), []);
  assert.deepEqual(store.mirrorDigest(dataDir, 'unregistered'), []);
});

// ---------------------------------------------------------------------------
// technical_context + clarity lint
// ---------------------------------------------------------------------------

test('technical_context: preserved by createRequest, validated as string array', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const created = store.createRequest(dataDir, {
    ...CHOICE_INPUT,
    technical_context: ['lib\\store.js answerRequest()', 'relates to D-103 / §3.5'],
  });
  assert.deepEqual(created.technical_context, ['lib\\store.js answerRequest()', 'relates to D-103 / §3.5']);
  const listed = store.listRequests(dataDir).requests.find((r) => r.id === created.id);
  assert.deepEqual(listed.technical_context, created.technical_context);
  assert.throws(
    () => store.createRequest(dataDir, { ...CHOICE_INPUT, technical_context: 'not-an-array' }),
    (e) => e.code === 'VALIDATION' && /technical_context/.test(e.message),
  );
});

test('lintClarity flags jargon in human-facing fields', () => {
  const base = { title: 'Plain title', ask: 'Plain ask?', response: { type: 'text' } };
  const cases = [
    [{ ...base, title: 'Fix lib\\store.js first' }, /file path/],
    [{ ...base, ask: 'See dev/agent-answers.md for details' }, /file path/],
    [{ ...base, ask: 'Per §3.5 this needs a ruling' }, /section reference/],
    [{ ...base, title: 'Blocked by D-103' }, /ID reference/],
    [{ ...base, ask: 'Should `answerRequest()` throw here?' }, /code span/],
    [{ ...base, background: ['S1 defines the blast radius of ADR-7'] }, /ID reference/],
    [{ ...base, ask: 'x'.repeat(401) }, /longer than 400/],
    [{
      ...base,
      response: { type: 'choice', options: [{ key: 'a', label: 'Use `fs.renameSync`' }] },
    }, /code span/],
    [{
      ...base,
      response: { type: 'choice', options: [{ key: 'a', label: 'Yes', description: 'edits src/lib/store.js' }] },
    }, /file path/],
  ];
  for (const [request, re] of cases) {
    const warnings = store.lintClarity(request);
    assert.ok(warnings.some((w) => re.test(w)),
      `expected ${re} in ${JSON.stringify(warnings)} for ${JSON.stringify(request).slice(0, 90)}`);
  }
});

test('lintClarity: negatives — plain language and technical_context never trigger', () => {
  const clean = {
    title: 'Should the app show full text by default?',
    ask: 'Should we add a yes/no toggle to the settings for showing the full text? A toggle is a small addition but one more thing to understand; always showing keeps things simple but long text may clutter the screen.',
    background: [
      'Some users find long text overwhelming; others want everything visible.',
      'Either choice ships this week — cost difference is small.',
    ],
    response: {
      type: 'choice',
      options: [
        { key: 'yes', label: 'Yes — add the toggle', description: 'small UI addition, one more setting for users to understand' },
        { key: 'no', label: 'No — always show full text', description: 'simpler, but long text may clutter the screen' },
      ],
    },
    technical_context: [
      'Toggle would live in settings.json and lib\\render.js — see D-103, §3.5, `renderCard()`',
    ],
  };
  assert.deepEqual(store.lintClarity(clean), []);
  // ordinary hyphenated words and "and/or" style slashes don't trigger
  assert.deepEqual(store.lintClarity({
    title: 'A well-known cause/effect trade-off',
    ask: 'Pick the trade-off and/or say why.',
    response: { type: 'text' },
  }), []);
});

test('listRequests attaches clarity_warnings; mutations never write them to disk', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const jargon = store.createRequest(dataDir, {
    ...CHOICE_INPUT, title: 'Blocked by D-103 in lib\\store.js',
  });
  const listed = store.listRequests(dataDir).requests.find((r) => r.id === jargon.id);
  assert.ok(Array.isArray(listed.clarity_warnings) && listed.clarity_warnings.length >= 1);
  store.answerRequest(dataDir, jargon.id, { value: 'md' });
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'requests', `${jargon.id}.json`), 'utf8'),
  );
  assert.equal(onDisk.clarity_warnings, undefined);
});

// ---------------------------------------------------------------------------
// returned status
// ---------------------------------------------------------------------------

test('setStatus returned: requires reason, stores it, only from open, digest excludes it', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const req = store.createRequest(dataDir, CHOICE_INPUT);

  assert.throws(
    () => store.setStatus(dataDir, req.id, { status: 'returned' }),
    (e) => e.code === 'VALIDATION' && /returned_reason/.test(e.message),
  );
  assert.throws(
    () => store.setStatus(dataDir, req.id, { status: 'returned', returned_reason: '   ' }),
    (e) => e.code === 'VALIDATION',
  );

  const reason = 'Please rewrite in plain language per PROTOCOL.md.';
  const returned = store.setStatus(dataDir, req.id, { status: 'returned', returned_reason: reason }).request;
  assert.equal(returned.status, 'returned');
  assert.equal(returned.returned_reason, reason);

  // Excluded from digest.
  const digest = fs.readFileSync(path.join(dataDir, 'answers', 'myproject.md'), 'utf8');
  assert.ok(!digest.includes(req.id));

  // Agent-style rewrite: back to open keeps returned_reason as history.
  const reopened = store.setStatus(dataDir, req.id, { status: 'open' }).request;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.returned_reason, reason);

  // returned is only reachable from open.
  store.answerRequest(dataDir, req.id, { value: 'md' });
  assert.throws(
    () => store.setStatus(dataDir, req.id, { status: 'returned', returned_reason: reason }),
    (e) => e.code === 'CONFLICT' && e.httpStatus === 409,
  );
});

// ---------------------------------------------------------------------------
// request archiving
// ---------------------------------------------------------------------------

test('archiveRequest: moves settled requests, 409 for open/archived, digest unchanged', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const open = store.createRequest(dataDir, { ...CHOICE_INPUT, title: 'Still open' });
  const done = store.createRequest(dataDir, { ...CHOICE_INPUT, title: 'All done' });
  store.answerRequest(dataDir, done.id, { value: 'json', notes: 'ship it' });
  const digestBefore = fs.readFileSync(path.join(dataDir, 'answers', 'myproject.md'), 'utf8');

  // Open requests cannot be archived.
  assert.throws(
    () => store.archiveRequest(dataDir, open.id),
    (e) => e.code === 'CONFLICT' && /only answered, withdrawn, superseded/.test(e.message),
  );

  const { request } = store.archiveRequest(dataDir, done.id);
  assert.equal(request.archived, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'requests', 'archive', `${done.id}.json`)));
  assert.ok(!fs.existsSync(path.join(dataDir, 'requests', `${done.id}.json`)));

  // Gone from the default listing / state; digest content unchanged.
  const { requests } = store.listRequests(dataDir);
  assert.ok(!requests.some((r) => r.id === done.id));
  assert.ok(requests.some((r) => r.id === open.id));
  store.generateDigest(dataDir, 'myproject');
  const digestAfter = fs.readFileSync(path.join(dataDir, 'answers', 'myproject.md'), 'utf8');
  assert.equal(digestAfter, digestBefore);

  // readRequest still finds it (flagged); mutations refuse politely.
  const found = store.readRequest(dataDir, done.id);
  assert.equal(found.archived, true);
  assert.equal(found.answer.value, 'json');
  assert.throws(
    () => store.answerRequest(dataDir, done.id, { value: 'md', force: true }),
    (e) => e.code === 'CONFLICT' && /archived/.test(e.message),
  );
  assert.throws(
    () => store.setStatus(dataDir, done.id, { status: 'open' }),
    (e) => e.code === 'CONFLICT' && /archived/.test(e.message),
  );
  assert.throws(
    () => store.archiveRequest(dataDir, done.id),
    (e) => e.code === 'CONFLICT' && /already archived/.test(e.message),
  );
  assert.throws(
    () => store.archiveRequest(dataDir, 'no-such-id'),
    (e) => e.code === 'NOT_FOUND',
  );

  // Boot regen still sees archived entries (digest slug scan includes archive).
  fs.rmSync(path.join(dataDir, 'answers'), { recursive: true, force: true });
  store.ensureStore(dataDir, null);
  const rebooted = fs.readFileSync(path.join(dataDir, 'answers', 'myproject.md'), 'utf8');
  assert.match(rebooted, /All done/);
});

// ---------------------------------------------------------------------------
// digest cap + archive digest
// ---------------------------------------------------------------------------

test('digest cap: newest 50 in main digest, older entries roll into <slug>-archive.md', () => {
  const dataDir = makeTmp();
  const repo = makeTmp();
  store.ensureStore(dataDir, null);
  writeProjects(dataDir, { bulk: { name: 'Bulk', repo, mirror: 'dev\\agent-answers.md' } });

  const total = 55;
  for (let i = 1; i <= total; i++) {
    const created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)); // strictly increasing
    const req = store.createRequest(dataDir, {
      project: 'bulk', title: `Question number ${i}`, ask: 'Pick.', response: { type: 'text' },
    }, created);
    store.answerRequest(dataDir, req.id, { value: `answer ${i}` }, created);
  }

  const main = fs.readFileSync(path.join(dataDir, 'answers', 'bulk.md'), 'utf8');
  const archive = fs.readFileSync(path.join(dataDir, 'answers', 'bulk-archive.md'), 'utf8');

  // Main: exactly 50 entries — the newest (6..55), newest first.
  assert.equal((main.match(/^## /gm) || []).length, 50);
  assert.ok(main.includes('Question number 55  '));
  assert.ok(main.includes('Question number 6  '));
  assert.ok(!main.includes('Question number 5  '));
  assert.ok(main.indexOf('Question number 55  ') < main.indexOf('Question number 6  '));
  assert.match(main, /5 older entries are in .*bulk-archive\.md/);

  // Archive: the 5 oldest (1..5), same format, newest first.
  assert.equal((archive.match(/^## /gm) || []).length, 5);
  assert.match(archive, /^# Agent Inbox — answered requests for Bulk \(archive\)/);
  assert.ok(archive.includes('Question number 5  '));
  assert.ok(archive.includes('Question number 1  '));
  assert.ok(!archive.includes('Question number 6  '));

  // Mirror carries only the main digest.
  const mirrored = fs.readFileSync(path.join(repo, 'dev', 'agent-answers.md'), 'utf8');
  assert.equal(mirrored, main);
  assert.ok(!fs.existsSync(path.join(repo, 'dev', 'agent-answers-archive.md')));
  assert.deepEqual(noTmpResidue(dataDir), []);
});

test('answering a request for a project with a broken mirror returns warnings, HTTP-ok path', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  writeProjects(dataDir, {
    demo: { name: 'Demo', repo: 'C:\\definitely\\not\\a\\real\\repo\\path', mirror: 'dev\\agent-answers.md' },
  });
  const req = store.createRequest(dataDir, { ...CHOICE_INPUT, project: 'demo' });
  const { request, mirror_warnings } = store.answerRequest(dataDir, req.id, { value: 'md' });
  assert.equal(request.status, 'answered'); // answer + digest still landed
  assert.equal(mirror_warnings.length, 1);
  assert.match(mirror_warnings[0], /repo directory not found/);
  assert.ok(fs.existsSync(path.join(dataDir, 'answers', 'demo.md')));
});

// ---------------------------------------------------------------------------
// silent-failure cures
// ---------------------------------------------------------------------------

test('unreadable requests directory is not an "empty inbox"; digests refuse to regenerate', () => {
  const dataDir = path.join(makeTmp(), 'store');
  fs.mkdirSync(path.join(dataDir, 'answers'), { recursive: true });
  // A plain FILE shadowing the requests directory: readdirSync -> ENOTDIR.
  fs.writeFileSync(path.join(dataDir, 'requests'), 'shadowing file', 'utf8');
  const sentinel = '# existing digest content — must survive a bad scan\n';
  fs.writeFileSync(path.join(dataDir, 'answers', 'demo.md'), sentinel, 'utf8');

  const { requests, invalid } = store.listRequests(dataDir);
  assert.equal(requests.length, 0);
  assert.ok(
    invalid.some((i) => i.file === 'requests\\' && /directory unreadable/.test(i.error)),
    `expected a directory-unreadable entry, got ${JSON.stringify(invalid)}`,
  );

  // generateDigest must refuse rather than atomically rewriting the digest empty.
  assert.throws(
    () => store.generateDigest(dataDir, 'demo'),
    (e) => e instanceof store.StoreError && e.code === 'IO' && /unreadable/.test(e.message),
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'answers', 'demo.md'), 'utf8'), sentinel);

  // Mirroring degrades to a warning; nothing is written into the repo.
  const repo = makeTmp();
  writeProjects(dataDir, { demo: { name: 'Demo', repo, mirror: 'x.md' } });
  const w = store.mirrorDigest(dataDir, 'demo');
  assert.equal(w.length, 1);
  assert.match(w[0], /unreadable/);
  assert.ok(!fs.existsSync(path.join(repo, 'x.md')));

  // A genuinely missing directory is still just an empty inbox.
  const empty = store.listRequests(path.join(makeTmp(), 'never-created'));
  assert.deepEqual(empty.requests, []);
  assert.deepEqual(empty.invalid, []);
});

test('unreadable projects.json surfaces in getState invalid (not treated as missing)', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  fs.rmSync(path.join(dataDir, 'projects.json'));
  fs.mkdirSync(path.join(dataDir, 'projects.json')); // readFileSync -> EISDIR
  const state = store.getState(dataDir);
  assert.deepEqual(state.projects, { schema_version: 1, projects: {} });
  assert.ok(
    state.invalid.some((i) => i.file === 'projects.json' && /unreadable/.test(i.error)),
    `expected an unreadable projects.json entry, got ${JSON.stringify(state.invalid)}`,
  );
});

test('digest failure after the request write commits: success with warnings, not a 500', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  writeProjects(dataDir, { demo: { name: 'Demo', repo: makeTmp(), mirror: 'x.md' } });
  const req = store.createRequest(dataDir, { ...CHOICE_INPUT, project: 'demo' });
  // Shadow the answers dir with a file so digest generation fails after the
  // request file has been written.
  fs.rmSync(path.join(dataDir, 'answers'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dataDir, 'answers'), 'shadowing file', 'utf8');

  const { request, mirror_warnings } = store.answerRequest(dataDir, req.id, { value: 'md' });
  assert.equal(request.status, 'answered');
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'requests', `${req.id}.json`), 'utf8'),
  );
  assert.equal(onDisk.status, 'answered'); // the commit stood
  assert.ok(mirror_warnings.some((w) => /digest for "demo" not regenerated/.test(w)),
    `expected digest warning, got ${JSON.stringify(mirror_warnings)}`);
  assert.ok(mirror_warnings.some((w) => /mirror for "demo" skipped/.test(w)));

  // setStatus takes the same commit-then-warn path.
  const res2 = store.setStatus(dataDir, req.id, { status: 'withdrawn' });
  assert.equal(res2.request.status, 'withdrawn');
  assert.ok(res2.mirror_warnings.some((w) => /not regenerated/.test(w)));
});

test('boot digest regen: one failing slug does not prevent the rest (or server start)', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  writeProjects(dataDir, { bad: { name: 'Bad' } });
  const req = store.createRequest(dataDir, { ...CHOICE_INPUT, project: 'good' });
  store.answerRequest(dataDir, req.id, { value: 'md' });
  fs.rmSync(path.join(dataDir, 'answers'), { recursive: true, force: true });
  // Block "bad"'s digest write target with a directory (rename onto it fails).
  fs.mkdirSync(path.join(dataDir, 'answers', 'bad.md'), { recursive: true });

  assert.doesNotThrow(() => store.ensureStore(dataDir, null));
  assert.match(
    fs.readFileSync(path.join(dataDir, 'answers', 'good.md'), 'utf8'),
    /Choose storage format/,
  );
  assert.ok(fs.statSync(path.join(dataDir, 'answers', 'bad.md')).isDirectory());
});

test('stale .tmp files in requests are reported; fresh ones are not', () => {
  const dataDir = makeTmp();
  store.ensureStore(dataDir, null);
  const reqDir = path.join(dataDir, 'requests');
  const stale = path.join(reqDir, 'x.json.1234.dead.tmp');
  const fresh = path.join(reqDir, 'y.json.1234.beef.tmp');
  fs.writeFileSync(stale, 'partial write', 'utf8');
  fs.writeFileSync(fresh, 'in-flight write', 'utf8');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  const { requests, invalid } = store.listRequests(dataDir);
  assert.equal(requests.length, 0);
  assert.ok(invalid.some((i) => i.file === 'x.json.1234.dead.tmp' && /stale temp file/.test(i.error)));
  assert.ok(!invalid.some((i) => i.file === 'y.json.1234.beef.tmp'));
});
