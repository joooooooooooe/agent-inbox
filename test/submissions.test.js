'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../lib/store');
const intake = require('../lib/submissions');
const { check } = require('../lib/check');
const dirs = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-intake-test-'));
  dirs.push(dir); store.ensureStore(dir, null); return dir;
}
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const input = { project: 'myproject', message: 'Do moving platforms exist or belong on the roadmap?' };
const now = new Date('2026-09-30T18:00:00Z');
function credentials(s) { return { expected_revision: s.revision, owner: s.claim.owner, token: s.claim.token }; }
function question(dir, title = 'Platform behavior?') {
  return store.createRequest(dir, { project: 'myproject', title, ask: 'Choose behavior?', response: { type: 'text' } });
}

test('submission retains original text, defaults, attribution; never enters standing answer digest', () => {
  const dir = fixture(), s = intake.create(dir, input, now);
  assert.equal(s.status, 'submitted'); assert.equal(s.priority, 'planned');
  const claimed = intake.claim(dir, s.id, { owner: 'owner-a', expected_revision: 1 }, now);
  const response = intake.respond(dir, s.id, { ...credentials(claimed), status: 'closed', message: 'Existing support verified.' }, now);
  assert.equal(response.message, input.message); assert.equal(response.events[0].actor, 'agent');
  store.generateDigest(dir, 'myproject');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'answers', 'myproject.md'), 'utf8'), /Existing support/);
  assert.equal(intake.publicRecord(claimed).claim.token, undefined);
  assert.throws(() => intake.create(dir, { ...input, priority: 'urgent' }), /priority/);
  assert.throws(() => intake.read(dir, '../bad'), /invalid submission/);
});

test('exclusive claims, expiry and stale revision/token checks protect operator corrections', () => {
  const dir = fixture(), s = intake.create(dir, input, now);
  const a = intake.claim(dir, s.id, { owner: 'a', expected_revision: 1 }, now);
  assert.throws(() => intake.claim(dir, s.id, { owner: 'b', expected_revision: a.revision }, now), /already claimed/);
  assert.throws(() => intake.respond(dir, s.id, { ...credentials(a), token: 'wrong', status: 'closed', message: 'done' }, now), /claim expired/);
  const edited = intake.operatorUpdate(dir, s.id, { expected_revision: a.revision, action: 'reply', message: 'I mean online multiplayer, too.' }, now);
  assert.equal(edited.claim, null); assert.equal(edited.message, input.message);
  assert.throws(() => intake.respond(dir, s.id, { ...credentials(a), status: 'closed', message: 'old assumptions' }, now), /changed/);
  const b = intake.claim(dir, s.id, { owner: 'b', expected_revision: edited.revision }, now);
  const future = new Date(now.getTime() + intake.LEASE_MS + 1);
  assert.throws(() => intake.respond(dir, s.id, { ...credentials(b), status: 'closed', message: 'late' }, future), /expired/);
  const c = intake.claim(dir, s.id, { owner: 'c', expected_revision: b.revision }, future);
  assert.equal(c.claim.owner, 'c');
  fs.writeFileSync(path.join(dir, 'submissions', `${s.id}.json.lock`), '{}');
  assert.throws(() => intake.operatorUpdate(dir, s.id, { expected_revision: c.revision, action: 'withdraw' }), /busy/);
  fs.unlinkSync(path.join(dir, 'submissions', `${s.id}.json.lock`));
});

test('marking an update read preserves revision/claim; new updates remain unread', () => {
  const dir = fixture(), s = intake.create(dir, input, now);
  const a = intake.claim(dir, s.id, { owner: 'a', expected_revision: 1 }, now);
  const update = intake.respond(dir, s.id, { ...credentials(a), status: 'checking', message: 'Checking the existing support.' }, now);
  assert.equal(intake.unread(update), true);
  const read = intake.markRead(dir, s.id, 0);
  assert.equal(read.revision, update.revision); assert.deepEqual(read.claim, update.claim);
  assert.equal(intake.unread(read), false);
  const result = intake.respond(dir, s.id, { ...credentials(update), status: 'closed', message: 'Verified.' }, now);
  intake.markRead(dir, s.id, 0); // stale view cannot mark the newer event read
  assert.equal(intake.unread(intake.read(dir, s.id)), true);
  assert.equal(result.status, 'closed');
});

test('route requires owner/reference; waiting links a same-project question and resumes after answer', () => {
  const dir = fixture(), s = intake.create(dir, input, now);
  const a = intake.claim(dir, s.id, { owner: 'a', expected_revision: 1 }, now);
  assert.throws(() => intake.respond(dir, s.id, { ...credentials(a), status: 'routed', message: 'Planned.' }, now), /owner and reference/);
  assert.throws(() => intake.respond(dir, s.id, { ...credentials(a), status: 'waiting', message: 'Need input.' }, now), /linked open/);
  const q = question(dir);
  const waiting = intake.respond(dir, s.id, { ...credentials(a), status: 'waiting', message: 'Please choose.', request_ids: [q.id] }, now);
  assert.throws(() => intake.claim(dir, s.id, { owner: 'b', expected_revision: waiting.revision }, now), /still waiting/);
  store.answerRequest(dir, q.id, { value: 'Carry the player.' });
  assert.equal(check(dir, 'myproject').submissions.total, 1);
  const b = intake.claim(dir, s.id, { owner: 'b', expected_revision: waiting.revision }, now);
  const routed = intake.respond(dir, s.id, { ...credentials(b), status: 'routed', message: 'Movement owner will implement it.',
    work: { owner: 'movement', reference: 'dev/movement/PLAN.md' } }, now);
  assert.equal(routed.status, 'routed'); assert.notEqual(routed.status, 'closed');
});

test('combined check honors project/topic, mandatory next-check, awaited archive/status and overflow', () => {
  const dir = fixture();
  const q = question(dir, 'Older named question');
  store.answerRequest(dir, q.id, { value: 'Original answer' });
  store.setStatus(dir, q.id, { status: 'withdrawn' }); store.archiveRequest(dir, q.id);
  for (let i = 0; i < 12; i++) intake.create(dir, { ...input, priority: 'next_check', title: `Unrelated ${i}` });
  intake.create(dir, { project: 'other', message: 'Secret other-project context' });
  intake.create(dir, { message: 'Please find the right project.' });
  intake.create(dir, { ...input, priority: 'later' });
  const result = check(dir, 'myproject', { topic: 'weapons', requests: [q.id], since: '2099-01-01', limit: 10 });
  assert.equal(result.watched[0].status, 'withdrawn'); assert.match(result.watched[0].file, /archive/);
  assert.equal(result.next_check.total, 12); assert.equal(result.next_check.items.length, 10); assert.equal(result.next_check.next_offset, 10);
  assert.equal(result.submissions.total, 0); assert.equal(result.unassigned.total, 1);
  assert.equal(JSON.stringify(result).includes('Secret other-project'), false);
  assert.equal(check(dir, 'myproject', { offset: 10 }).next_check.items.length, 2);
  assert.equal(check(dir, 'myproject', { topic: 'moving' }).submissions.total, 1);
  assert.throws(() => check(dir, 'myproject', { limit: 0 }), /limit/);
  assert.throws(() => check(dir, 'myproject', { requests: ['missing'] }), /no request/);
});

test('unassigned intake can be claimed only for routing; corruption is surfaced', () => {
  const dir = fixture(), s = intake.create(dir, { message: 'Where does this belong?' }, now);
  const a = intake.claim(dir, s.id, { owner: 'coordinator', expected_revision: 1 }, now);
  assert.throws(() => intake.respond(dir, s.id, { ...credentials(a), status: 'closed', message: 'Handled.' }, now), /assign the project/);
  const assigned = intake.assign(dir, s.id, { ...credentials(a), project: 'myproject', message: 'This belongs with movement.' }, now);
  assert.equal(assigned.project, 'myproject'); assert.equal(assigned.claim, null); assert.equal(assigned.status, 'submitted');
  fs.writeFileSync(path.join(dir, 'submissions', 'sub-broken.json'), '{bad');
  assert.equal(check(dir, 'myproject').problems.total, 1);
});

test('operator follow-ups are searchable and priority changes reactivate routed/deferred work', () => {
  const dir = fixture(), s = intake.create(dir, input, now);
  const a = intake.claim(dir, s.id, { owner: 'a', expected_revision: 1 }, now);
  const routed = intake.respond(dir, s.id, { ...credentials(a), status: 'routed', message: 'Scheduled later.',
    work: { owner: 'movement', reference: 'dev/PLAN.md' } }, now);
  const urgent = intake.operatorUpdate(dir, s.id, { expected_revision: routed.revision, action: 'priority', priority: 'next_check' }, now);
  assert.equal(urgent.status, 'submitted'); assert.deepEqual(urgent.work, routed.work);
  assert.equal(check(dir, 'myproject', { topic: 'unrelated' }).next_check.total, 1);
  const lowered = intake.operatorUpdate(dir, s.id, { expected_revision: urgent.revision, action: 'priority', priority: 'planned' }, now);
  intake.operatorUpdate(dir, s.id, { expected_revision: lowered.revision, action: 'reply', message: 'Multiplayer is the part I care about.' }, now);
  assert.equal(check(dir, 'myproject', { topic: 'multiplayer' }).submissions.total, 1);
});

test('malformed structured records are isolated and a broken waiting link is repairable', () => {
  const dir = fixture(), s = intake.create(dir, input, now);
  for (const [key, value] of [['created', null], ['request_ids', null], ['work', {}], ['claim', {}], ['seen_event', 2], ['events', [{ actor: 'agent', message: 'ok', at: 'bad' }]]]) {
    fs.writeFileSync(path.join(dir, 'submissions', `${s.id}.json`), JSON.stringify({ ...s, [key]: value }));
    const result = check(dir, 'myproject');
    assert.equal(result.problems.total, 1, key); assert.equal(result.submissions.total, 0);
  }
  fs.writeFileSync(path.join(dir, 'submissions', `${s.id}.json`), JSON.stringify(s));
  const q = question(dir), a = intake.claim(dir, s.id, { owner: 'a', expected_revision: 1 }, now);
  const waiting = intake.respond(dir, s.id, { ...credentials(a), status: 'waiting', message: 'Choose behavior.', request_ids: [q.id] }, now);
  fs.unlinkSync(path.join(dir, 'requests', `${q.id}.json`));
  assert.equal(check(dir, 'myproject').submissions.items[0].broken_links, 1);
  const repair = intake.claim(dir, s.id, { owner: 'b', expected_revision: waiting.revision }, now);
  const fixed = intake.respond(dir, s.id, { ...credentials(repair), status: 'deferred', message: 'Question missing; retained for planning.', request_ids: [] }, now);
  assert.deepEqual(fixed.request_ids, []);
});

test('discovery caps actionable previews at ten and supports targeted overflow pages', () => {
  const dir = fixture();
  for (let i = 0; i < 8; i++) intake.create(dir, { ...input, priority: 'next_check', title: `Urgent ${i}` });
  for (let i = 0; i < 8; i++) intake.create(dir, { ...input, title: `Normal ${i}` });
  const result = check(dir, 'myproject');
  assert.equal(result.next_check.items.length + result.submissions.items.length, 10);
  assert.equal(result.submissions.next_offset, 2);
  assert.equal(check(dir, 'myproject', { section: 'submissions', offset: 2 }).submissions.items.length, 6);
});

test('combined topic check tolerates unrelated v1 metadata', () => {
  const dir = fixture();
  store.createRequest(dir, { project: 'myproject', title: 'Platform choices', ask: 'Choose behavior?', response: { type: 'text' }, events: 'agent-specific metadata' });
  assert.equal(check(dir, 'myproject', { topic: 'platform' }).open_questions.total, 1);
});

test('two independent CLI processes competing to claim have exactly one winner', async () => {
  const dir = fixture(), s = intake.create(dir, input);
  const cli = path.join(__dirname, '..', 'agent.js');
  const run = (owner) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'claim', s.id, '--data-dir', dir, '--owner', owner, '--revision', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', reject); child.on('exit', (code) => resolve(code));
  });
  const codes = await Promise.all([run('a'), run('b')]);
  assert.deepEqual(codes.sort(), [0, 1]);
  assert.equal(intake.read(dir, s.id).revision, 2);
});
