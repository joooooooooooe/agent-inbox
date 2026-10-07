'use strict';

// Operator-originated intake is separate from requests and their decision digests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const PRIORITIES = ['next_check', 'planned', 'later'];
const STATUSES = ['submitted', 'checking', 'waiting', 'routed', 'deferred', 'closed', 'withdrawn'];
const LEASE_MS = 30 * 60 * 1000;
const slugOK = (s) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s);
const fail = (code, message) => { throw new store.StoreError(code, message); };
const root = (dir) => path.join(dir, 'submissions');
function file(dir, id) {
  if (!store.validateId(id) || !id.startsWith('sub-')) fail('VALIDATION', 'invalid submission id');
  return path.join(root(dir), `${id}.json`);
}
function text(value, name, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('VALIDATION', `${name} must be non-empty text (at most ${max} characters)`);
  }
  return value.trim();
}
function validate(s) {
  const stamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
  const nonempty = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const workOK = !s?.work || (nonempty(s.work.owner, 200) && nonempty(s.work.reference, 2000));
  const claimOK = !s?.claim || (nonempty(s.claim.owner, 200) && /^[a-f0-9]{32}$/.test(s.claim.token) && stamp(s.claim.expires_at));
  if (!s || s.schema_version !== 1 || !slugOK(s.project) || !STATUSES.includes(s.status) ||
      !PRIORITIES.includes(s.priority) || !Number.isSafeInteger(s.revision) || s.revision < 1 ||
      !nonempty(s.title, 200) || !nonempty(s.message, 20000) || !stamp(s.created) || !stamp(s.updated) ||
      !workOK || !claimOK || !(s.work === null || typeof s.work === 'object') || !(s.claim === null || typeof s.claim === 'object') ||
      !Number.isSafeInteger(s.seen_event) || s.seen_event < -1 ||
      !Array.isArray(s.request_ids) || s.request_ids.length > 20 || s.request_ids.some((id) => !store.validateId(id)) ||
      !Array.isArray(s.events) || !s.events.every((e) => e && ['operator', 'agent'].includes(e.actor) &&
        nonempty(e.message, 20000) && stamp(e.at) && (e.owner === undefined || nonempty(e.owner, 200)) &&
        (e.status === undefined || STATUSES.includes(e.status))) || s.seen_event >= s.events.length) {
    fail('VALIDATION', 'invalid submission record');
  }
  return s;
}
function read(dir, id) {
  try {
    const raw = fs.readFileSync(file(dir, id), 'utf8').replace(/^\uFEFF/, '');
    return { ...validate(JSON.parse(raw)), id };
  } catch (err) {
    if (err instanceof store.StoreError) throw err;
    fail(err.code === 'ENOENT' ? 'NOT_FOUND' : 'IO', `cannot read submission ${id}: ${err.message}`);
  }
}
function list(dir) {
  const submissions = [], invalid = [];
  let names;
  try { names = fs.readdirSync(root(dir)); }
  catch (err) {
    if (err.code !== 'ENOENT') invalid.push({ file: 'submissions/', error: err.message });
    return { submissions, invalid };
  }
  for (const name of names.sort()) {
    if (name.endsWith('.lock')) {
      // A crashed short mutation lock must be investigated, never stolen by a timer.
      try {
        if (Date.now() - fs.statSync(path.join(root(dir), name)).mtimeMs > 60000) {
          invalid.push({ file: `submissions/${name}`, error: 'mutation lock remains; verify its recorded process before removing it' });
        }
      } catch (_) { /* mutation finished */ }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try { submissions.push(read(dir, name.slice(0, -5))); }
    catch (err) { invalid.push({ file: `submissions/${name}`, error: err.message }); }
  }
  return { submissions, invalid };
}
function save(dir, s) { store.atomicWriteFile(file(dir, s.id), JSON.stringify(s, null, 2) + '\n'); }

// Every UI/CLI mutation uses the same short, exclusive filesystem lock. A claim
// is a longer logical lease, not the mutex. Refuse a leftover mutex rather than
// risk deleting a new writer's lock during competing stale-lock recovery.
function locked(dir, id, fn) {
  const lock = file(dir, id) + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (err) { fail(err.code === 'EEXIST' ? 'CONFLICT' : 'IO', `submission busy: ${lock}; retry after the current writer finishes`); }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
function revision(s, expected) {
  if (!Number.isSafeInteger(expected)) fail('VALIDATION', 'expected_revision is required');
  if (s.revision !== expected) fail('CONFLICT', 'submission changed; reread before acting');
}
function activeClaim(s, now = new Date()) {
  return !!(s.claim && Date.parse(s.claim.expires_at) > now.getTime());
}
function waitingReady(dir, s) {
  return s.request_ids.some((id) => {
    try { return ['answered', 'withdrawn', 'superseded'].includes(store.readRequest(dir, id).status); }
    catch (_) { return true; } // repair a missing/corrupt linked question under a claim
  });
}
function requireClaim(s, input, now) {
  revision(s, input.expected_revision);
  if (!activeClaim(s, now) || s.claim.owner !== input.owner || s.claim.token !== input.token) {
    fail('CONFLICT', 'claim expired, changed, or belongs to another agent; claim the current record again');
  }
}
function addEvent(s, actor, message, now, extra = {}) {
  s.events.push({ actor, message, at: now.toISOString(), ...extra });
  s.revision++;
  s.updated = now.toISOString();
}
function create(dir, input, now = new Date()) {
  const message = text(input.message, 'message');
  const project = input.project || 'unassigned';
  if (!slugOK(project)) fail('VALIDATION', 'invalid project slug');
  const priority = input.priority || 'planned';
  if (!PRIORITIES.includes(priority)) fail('VALIDATION', 'invalid priority');
  const title = input.title ? text(input.title, 'title', 200) : message.split('\n')[0].slice(0, 100);
  fs.mkdirSync(root(dir), { recursive: true });
  let id;
  do { id = 'sub-' + store.generateId(project, title, now); } while (fs.existsSync(file(dir, id)));
  const s = { schema_version: 1, id, project, title, message, priority, status: 'submitted',
    revision: 1, created: now.toISOString(), updated: now.toISOString(), claim: null,
    events: [], seen_event: -1, work: null, request_ids: [] };
  return locked(dir, id, () => { save(dir, s); return s; });
}
function claim(dir, id, input, now = new Date()) {
  const owner = text(input.owner, 'owner', 200);
  return locked(dir, id, () => {
    const s = read(dir, id);
    revision(s, input.expected_revision);
    if (['closed', 'withdrawn'].includes(s.status)) fail('CONFLICT', `cannot claim a ${s.status} submission`);
    if (s.status === 'waiting' && !waitingReady(dir, s)) {
      fail('CONFLICT', 'still waiting for an operator answer');
    }
    if (activeClaim(s, now)) fail('CONFLICT', `already claimed by ${s.claim.owner} until ${s.claim.expires_at}`);
    s.claim = { owner, token: crypto.randomBytes(16).toString('hex'), expires_at: new Date(now.getTime() + LEASE_MS).toISOString() };
    s.status = 'checking';
    s.revision++;
    s.updated = now.toISOString();
    save(dir, s);
    return s;
  });
}
function renew(dir, id, input, now = new Date()) {
  return locked(dir, id, () => {
    const s = read(dir, id);
    requireClaim(s, input, now);
    s.claim.expires_at = new Date(now.getTime() + LEASE_MS).toISOString();
    s.revision++;
    save(dir, s);
    return s;
  });
}
function respond(dir, id, input, now = new Date()) {
  const message = text(input.message, 'message');
  if (!['checking', 'waiting', 'routed', 'deferred', 'closed'].includes(input.status)) fail('VALIDATION', 'invalid response status');
  return locked(dir, id, () => {
    const s = read(dir, id);
    requireClaim(s, input, now);
    if (s.project === 'unassigned') fail('VALIDATION', 'assign the project before recording a work disposition');
    let work = s.work;
    if (input.work !== undefined) {
      if (!input.work || typeof input.work !== 'object') fail('VALIDATION', 'work must name its owner and reference');
      work = { owner: text(input.work.owner, 'work owner', 200), reference: text(input.work.reference, 'work reference', 2000) };
    }
    if (input.status === 'routed' && !work) fail('VALIDATION', 'routed needs a work owner and reference; routing is not completion');
    const ids = input.request_ids === undefined ? s.request_ids : input.request_ids;
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((r) => !store.validateId(r))) fail('VALIDATION', 'request_ids must be valid request ids');
    for (const requestId of ids) {
      if (store.readRequest(dir, requestId).project !== s.project) fail('VALIDATION', 'linked question must belong to the same project');
    }
    if (input.status === 'waiting' && !ids.some((r) => store.readRequest(dir, r).status === 'open')) {
      fail('VALIDATION', 'waiting needs a linked open Needs-you question');
    }
    s.work = work;
    s.request_ids = ids;
    s.status = input.status;
    if (input.status !== 'checking') s.claim = null;
    addEvent(s, 'agent', message, now, { owner: input.owner, status: s.status });
    save(dir, s);
    return s;
  });
}
function operatorUpdate(dir, id, input, now = new Date()) {
  return locked(dir, id, () => {
    const s = read(dir, id);
    revision(s, input.expected_revision);
    let message;
    switch (input.action) {
      case 'reply':
        message = text(input.message, 'message');
        s.status = 'submitted';
        break;
      case 'priority':
        if (!PRIORITIES.includes(input.priority)) fail('VALIDATION', 'invalid priority');
        s.priority = input.priority;
        if (!['closed', 'withdrawn'].includes(s.status)) s.status = 'submitted';
        message = `Priority changed to ${{ next_check: 'Address Now', planned: 'Fit into planned work', later: 'Keep for later' }[input.priority]}.`;
        break;
      case 'project':
        if (!slugOK(input.project) || input.project === 'unassigned') fail('VALIDATION', 'choose a project');
        s.project = input.project;
        s.status = 'submitted';
        s.work = null;
        s.request_ids = [];
        message = `Assigned to ${input.project}.`;
        break;
      case 'withdraw': s.status = 'withdrawn'; message = 'Submission withdrawn.'; break;
      case 'reopen': s.status = 'submitted'; message = 'Submission reopened.'; break;
      default: fail('VALIDATION', 'invalid operator action');
    }
    if (s.status === 'checking') s.status = 'submitted';
    s.claim = null;
    addEvent(s, 'operator', message, now);
    save(dir, s);
    return s;
  });
}
function assign(dir, id, input, now = new Date()) {
  if (!slugOK(input.project) || input.project === 'unassigned') fail('VALIDATION', 'choose a project');
  const message = text(input.message, 'routing explanation');
  return locked(dir, id, () => {
    const s = read(dir, id);
    requireClaim(s, input, now);
    s.project = input.project;
    s.work = null;
    s.request_ids = [];
    s.claim = null;
    s.status = 'submitted';
    addEvent(s, 'agent', message, now, { owner: input.owner, status: 'submitted' });
    save(dir, s);
    return s;
  });
}
function markRead(dir, id, through) {
  return locked(dir, id, () => {
    const s = read(dir, id);
    if (!Number.isSafeInteger(through) || through < -1 || through >= s.events.length) fail('VALIDATION', 'invalid read position');
    s.seen_event = Math.max(s.seen_event ?? -1, through);
    // Presentation metadata never changes revision, claim, or updated time.
    save(dir, s);
    return s;
  });
}
function unread(s) { return s.events.some((e, i) => e.actor === 'agent' && i > (s.seen_event ?? -1)); }
function publicRecord(s) {
  return { ...s, claim: s.claim ? { owner: s.claim.owner, expires_at: s.claim.expires_at } : null, unread: unread(s) };
}
module.exports = { PRIORITIES, STATUSES, LEASE_MS, read, list, create, claim, renew, respond,
  assign, operatorUpdate, markRead, activeClaim, publicRecord, unread, waitingReady };
