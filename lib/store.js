'use strict';

// Agent Inbox — store layer.
// All functions take the data dir explicitly; no module-level state.
// Synchronous fs throughout (deliberate: single-user, local, tiny scale).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RESPONSE_TYPES = Object.freeze(['choice', 'multi_select', 'text', 'checklist', 'approval']);
const OPTION_TYPES = Object.freeze(['choice', 'multi_select', 'checklist']);
const URGENCIES = Object.freeze(['high', 'medium', 'low']);
const STATUS_TARGETS = Object.freeze(['open', 'withdrawn', 'superseded', 'returned']);
const ARCHIVABLE_STATUSES = Object.freeze(['answered', 'withdrawn', 'superseded']);
const DIGEST_MAX_ENTRIES = 50;

const ID_RE = /^[A-Za-z0-9-]+$/;
const ID_MAX_LENGTH = 200;
const SLUG_RE = /^[a-z0-9-]+$/;

const HTTP_STATUS = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IO: 500,
};

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code] || 500;
  }
}

function fail(code, message) {
  throw new StoreError(code, message);
}

// JSON.parse that tolerates a UTF-8 BOM (PowerShell's Set-Content -Encoding
// UTF8 writes one; agents on Windows will produce such files routinely).
function parseJson(raw) {
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function requestsDir(dataDir) {
  return path.join(dataDir, 'requests');
}

function archiveDir(dataDir) {
  return path.join(dataDir, 'requests', 'archive');
}

function answersDir(dataDir) {
  return path.join(dataDir, 'answers');
}

function projectsPath(dataDir) {
  return path.join(dataDir, 'projects.json');
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

function atomicWriteFile(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
  } catch (err) {
    fail('IO', `failed to write temp file for ${filePath}: ${err.message}`);
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    let leftover = '';
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      leftover = `; temp file left behind: ${tmp}`;
    }
    fail('IO', `failed to replace ${filePath}: ${err.message}${leftover}`);
  }
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

function validateId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= ID_MAX_LENGTH && ID_RE.test(id);
}

function kebab(text, maxLen = 40) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return slug || 'request';
}

function generateId(project, title, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hex = crypto.randomBytes(2).toString('hex');
  return `${y}${m}${d}-${project}-${kebab(title)}-${hex}`;
}

// ---------------------------------------------------------------------------
// projects.json
// ---------------------------------------------------------------------------

const EMPTY_REGISTRY = Object.freeze({ schema_version: 1, projects: {} });

function readProjectsRaw(dataDir) {
  const p = projectsPath(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { registry: { schema_version: 1, projects: {} }, error: null };
    }
    // Unreadable is NOT missing — surface it, otherwise mirrors silently
    // stop happening while everything looks healthy.
    return {
      registry: { schema_version: 1, projects: {} },
      error: `unreadable: ${err.message}`,
    };
  }
  try {
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
      return {
        registry: { schema_version: 1, projects: {} },
        error: 'projects.json is not an object with a "projects" map',
      };
    }
    return { registry: parsed, error: null };
  } catch (err) {
    return {
      registry: { schema_version: 1, projects: {} },
      error: `invalid JSON: ${err.message}`,
    };
  }
}

function readProjects(dataDir) {
  return readProjectsRaw(dataDir).registry;
}

// ---------------------------------------------------------------------------
// Requests: read / list
// ---------------------------------------------------------------------------

function coreFieldProblem(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'request body is not a JSON object';
  }
  if (typeof body.project !== 'string' || !SLUG_RE.test(body.project)) {
    return 'missing or invalid "project" (must be a lowercase slug: a-z, 0-9, -)';
  }
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    return 'missing or empty "title"';
  }
  if (!body.response || typeof body.response !== 'object' || Array.isArray(body.response)) {
    return 'missing "response" object';
  }
  if (!RESPONSE_TYPES.includes(body.response.type)) {
    return `invalid "response.type" (must be one of ${RESPONSE_TYPES.join(', ')})`;
  }
  return null;
}

const TMP_STALE_MS = 10 * 60 * 1000; // temp files older than this are stale

// Scan one directory of request files (non-recursive; subdirectories such as
// requests\archive are naturally skipped because they don't end in .json).
// `unreadable: true` means the directory exists but could not be listed —
// callers must NOT treat that as "empty inbox".
function scanRequestsDir(dir) {
  const requests = [];
  const invalid = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { requests, invalid, unreadable: false }; // genuinely no dir yet
    }
    invalid.push({
      file: `${path.basename(dir)}\\`,
      error: `directory unreadable: ${err.message}`,
    });
    return { requests, invalid, unreadable: true };
  }
  for (const name of names.sort()) {
    if (name.endsWith('.tmp')) {
      // Leftover from a failed atomic write? Only report it once it's old
      // enough that no in-flight write can plausibly own it.
      try {
        const st = fs.statSync(path.join(dir, name));
        if (Date.now() - st.mtimeMs > TMP_STALE_MS) {
          invalid.push({ file: name, error: 'stale temp file — a write may have failed; safe to delete' });
        }
      } catch (_) {
        // vanished between readdir and stat — a write just completed; fine
      }
      continue;
    }
    if (!name.endsWith('.json')) continue; // non-JSON files ignored
    const base = name.slice(0, -'.json'.length);
    if (!validateId(base)) {
      invalid.push({ file: name, error: 'filename (minus .json) is not a valid request id' });
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (err) {
      invalid.push({ file: name, error: `unreadable: ${err.message}` });
      continue;
    }
    let body;
    try {
      body = parseJson(raw);
    } catch (err) {
      invalid.push({ file: name, error: `invalid JSON: ${err.message}` });
      continue;
    }
    const problem = coreFieldProblem(body);
    if (problem) {
      invalid.push({ file: name, error: problem });
      continue;
    }
    body.id = base; // filename is the canonical id (body mismatch tolerated)
    requests.push(body);
  }
  return { requests, invalid, unreadable: false };
}

// ---------------------------------------------------------------------------
// Clarity lint (advisory — never blocks filing or answering)
// ---------------------------------------------------------------------------

// Patterns that suggest the human-facing text leans on jargon or internal
// references that belong in technical_context instead.
const CLARITY_PATTERNS = [
  {
    re: /[\w.-]+[\\/][\w.-]+\.[A-Za-z0-9]{1,5}\b/,
    msg: 'looks like a file path — move it to technical_context',
  },
  {
    re: /§/,
    msg: 'contains a section reference (§) — move it to technical_context',
  },
  {
    re: /\b[A-Z]{1,6}-\d+\b/,
    msg: 'contains an internal ID reference (like "D-103") — move it to technical_context',
  },
  {
    re: /`[^`]+`/,
    msg: 'contains a backticked code span — move code identifiers to technical_context',
  },
];

const ASK_MAX_CHARS = 400;

// Lints the HUMAN-FACING fields only: title, ask, background, option
// labels/descriptions. technical_context is the jargon quarantine and is
// deliberately never linted.
function lintClarity(request) {
  const warnings = new Set();
  const fields = [];
  if (typeof request.title === 'string') fields.push(['title', request.title]);
  if (typeof request.ask === 'string') fields.push(['ask', request.ask]);
  if (Array.isArray(request.background)) {
    for (const s of request.background) {
      if (typeof s === 'string') fields.push(['background', s]);
    }
  }
  if (request.response && Array.isArray(request.response.options)) {
    for (const opt of request.response.options) {
      if (!opt || typeof opt !== 'object') continue;
      if (typeof opt.label === 'string') fields.push(['option label', opt.label]);
      if (typeof opt.description === 'string') fields.push(['option description', opt.description]);
    }
  }
  for (const [where, text] of fields) {
    for (const { re, msg } of CLARITY_PATTERNS) {
      if (re.test(text)) warnings.add(`${where}: ${msg}`);
    }
  }
  if (typeof request.ask === 'string' && request.ask.length > ASK_MAX_CHARS) {
    warnings.add(`ask: longer than ${ASK_MAX_CHARS} characters — too long to be a card; tighten it to the decision itself`);
  }
  return [...warnings];
}

function listRequests(dataDir) {
  const { requests, invalid } = scanRequestsDir(requestsDir(dataDir));
  for (const r of requests) r.clarity_warnings = lintClarity(r);
  return { requests, invalid };
}

// All requests, live + archived — used by digest generation so that archiving
// a request never changes digest content. `unreadable` is true when either
// directory exists but could not be listed; digests must not be regenerated
// from such a scan (they would be rewritten as empty).
function listRequestsForDigest(dataDir) {
  const live = scanRequestsDir(requestsDir(dataDir));
  const archived = scanRequestsDir(archiveDir(dataDir));
  return {
    requests: live.requests.concat(archived.requests),
    unreadable: live.unreadable || archived.unreadable,
  };
}

// Internal: read one request file for mutation. Body returned verbatim
// (id NOT injected) so read-modify-write preserves the file exactly.
// Falls back to requests\archive when the live file is absent; callers that
// mutate must check the returned `archived` flag.
function readRequestFile(dataDir, id) {
  if (!validateId(id)) fail('VALIDATION', `invalid request id "${id}"`);
  let filePath = path.join(requestsDir(dataDir), `${id}.json`);
  let archived = false;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') fail('IO', `failed to read request "${id}": ${err.message}`);
    filePath = path.join(archiveDir(dataDir), `${id}.json`);
    archived = true;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err2) {
      if (err2.code === 'ENOENT') fail('NOT_FOUND', `no request with id "${id}"`);
      fail('IO', `failed to read request "${id}": ${err2.message}`);
    }
  }
  let body;
  try {
    body = parseJson(raw);
  } catch (err) {
    fail('VALIDATION', `request file "${id}.json" is not valid JSON: ${err.message}`);
  }
  const problem = coreFieldProblem(body);
  if (problem) fail('VALIDATION', `request file "${id}.json" is invalid: ${problem}`);
  return { body, filePath, archived };
}

function readRequest(dataDir, id) {
  const { body, archived } = readRequestFile(dataDir, id);
  return { ...body, id, ...(archived ? { archived: true } : {}) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function validateOptions(response) {
  if (!Array.isArray(response.options) || response.options.length === 0) {
    fail('VALIDATION', `response.type "${response.type}" requires a non-empty "response.options" array`);
  }
  const seen = new Set();
  for (const opt of response.options) {
    if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
      fail('VALIDATION', 'every option must be an object with a "key"');
    }
    if (typeof opt.key !== 'string' || opt.key.trim() === '') {
      fail('VALIDATION', 'every option needs a non-empty string "key"');
    }
    if (seen.has(opt.key)) {
      fail('VALIDATION', `duplicate option key "${opt.key}"`);
    }
    seen.add(opt.key);
  }
}

const SERVER_OWNED_FIELDS = ['schema_version', 'id', 'created', 'status', 'answer', 'superseded_by'];
const KNOWN_INPUT_FIELDS = [
  'project', 'agent', 'title', 'ask', 'background', 'urgency', 'blocking',
  'response', 'on_answered', 'technical_context', ...SERVER_OWNED_FIELDS,
];

function createRequest(dataDir, input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('VALIDATION', 'request body must be a JSON object');
  }
  if (typeof input.project !== 'string' || !SLUG_RE.test(input.project)) {
    fail('VALIDATION', '"project" must be a lowercase slug (a-z, 0-9, -)');
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    fail('VALIDATION', '"title" must be a non-empty string');
  }
  if (typeof input.ask !== 'string' || input.ask.trim() === '') {
    fail('VALIDATION', '"ask" must be a non-empty string');
  }
  if (!input.response || typeof input.response !== 'object' || Array.isArray(input.response)) {
    fail('VALIDATION', '"response" must be an object with a "type"');
  }
  if (!RESPONSE_TYPES.includes(input.response.type)) {
    fail('VALIDATION', `"response.type" must be one of ${RESPONSE_TYPES.join(', ')}`);
  }
  if (OPTION_TYPES.includes(input.response.type)) {
    validateOptions(input.response);
  }
  if (input.urgency !== undefined && !URGENCIES.includes(input.urgency)) {
    fail('VALIDATION', `"urgency" must be one of ${URGENCIES.join(', ')}`);
  }
  if (input.blocking !== undefined && typeof input.blocking !== 'boolean') {
    fail('VALIDATION', '"blocking" must be a boolean');
  }
  for (const field of ['background', 'on_answered', 'technical_context']) {
    if (input[field] !== undefined &&
        (!Array.isArray(input[field]) || input[field].some((s) => typeof s !== 'string'))) {
      fail('VALIDATION', `"${field}" must be an array of strings`);
    }
  }
  if (input.agent !== undefined && (typeof input.agent !== 'string' || input.agent.trim() === '')) {
    fail('VALIDATION', '"agent" must be a non-empty string');
  }

  fs.mkdirSync(requestsDir(dataDir), { recursive: true });

  let id;
  let filePath;
  for (let attempt = 0; ; attempt++) {
    id = generateId(input.project, input.title, now);
    filePath = path.join(requestsDir(dataDir), `${id}.json`);
    if (!fs.existsSync(filePath)) break;
    if (attempt >= 20) fail('IO', 'could not generate a unique request id');
  }

  const record = {
    schema_version: 1,
    id,
    project: input.project,
    agent: input.agent !== undefined ? input.agent : 'human',
    title: input.title,
    ask: input.ask,
    background: input.background !== undefined ? input.background : [],
    urgency: input.urgency !== undefined ? input.urgency : 'medium',
    blocking: input.blocking !== undefined ? input.blocking : false,
    response: input.response,
    on_answered: input.on_answered !== undefined ? input.on_answered : [],
    ...(input.technical_context !== undefined ? { technical_context: input.technical_context } : {}),
    created: now.toISOString(),
    status: 'open',
    answer: null,
    superseded_by: null,
  };
  // Preserve any extra fields the caller passed (server-owned fields stay ours).
  for (const key of Object.keys(input)) {
    if (!KNOWN_INPUT_FIELDS.includes(key)) record[key] = input[key];
  }

  atomicWriteFile(filePath, JSON.stringify(record, null, 2) + '\n');
  // Open requests never appear in digests; no digest refresh here.
  return record;
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

function optionKeys(response) {
  if (!Array.isArray(response.options) || response.options.length === 0) {
    fail('VALIDATION', `response.type "${response.type}" has no options to answer against`);
  }
  const keys = response.options.map((o) => (o && typeof o === 'object' ? o.key : undefined));
  if (keys.some((k) => typeof k !== 'string' || k === '')) {
    fail('VALIDATION', 'request has malformed options (every option needs a string "key")');
  }
  return keys;
}

function validateAnswerShape(response, value) {
  const type = response && typeof response === 'object' ? response.type : undefined;
  switch (type) {
    case 'choice': {
      const keys = optionKeys(response);
      if (typeof value !== 'string') {
        fail('VALIDATION', 'choice answer value must be a string (one option key)');
      }
      if (!keys.includes(value)) {
        fail('VALIDATION', `"${value}" is not one of the option keys: ${keys.join(', ')}`);
      }
      return;
    }
    case 'multi_select':
    case 'checklist': {
      const keys = optionKeys(response);
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        fail('VALIDATION', `${type} answer value must be an array of option-key strings`);
      }
      const seen = new Set();
      for (const v of value) {
        if (!keys.includes(v)) {
          fail('VALIDATION', `"${v}" is not one of the option keys: ${keys.join(', ')}`);
        }
        if (seen.has(v)) fail('VALIDATION', `duplicate key "${v}" in answer value`);
        seen.add(v);
      }
      return;
    }
    case 'text': {
      if (typeof value !== 'string' || value.trim() === '') {
        fail('VALIDATION', 'text answer value must be a non-empty string');
      }
      return;
    }
    case 'approval': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('VALIDATION', 'approval answer value must be an object like {"decision":"approve"}');
      }
      if (value.decision !== 'approve' && value.decision !== 'reject') {
        fail('VALIDATION', 'approval decision must be "approve" or "reject"');
      }
      return;
    }
    default:
      fail('VALIDATION', `unknown response.type "${type}"`);
  }
}

function answerRequest(dataDir, id, { value, notes, force = false } = {}, now = new Date()) {
  const { body, filePath, archived } = readRequestFile(dataDir, id);
  if (archived) {
    fail('CONFLICT', `request "${id}" is archived; restore it by moving the file out of requests\\archive manually`);
  }
  if (body.status !== 'open' && force !== true) {
    fail('CONFLICT', `request is already "${body.status}" — pass force: true to overwrite`);
  }
  validateAnswerShape(body.response, value);
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    fail('VALIDATION', '"notes" must be a string');
  }

  const answer = { value };
  if (typeof notes === 'string' && notes.trim() !== '') answer.notes = notes;
  answer.answered_at = now.toISOString();

  // Mutate only status/answer on the parsed object; unknown fields survive.
  body.status = 'answered';
  body.answer = answer;
  atomicWriteFile(filePath, JSON.stringify(body, null, 2) + '\n');

  const mirror_warnings = refreshDigestAndMirror(dataDir, body.project);
  return { request: { ...body, id }, mirror_warnings };
}

// The request-file write is the commit point of every mutation. Digest/mirror
// refresh failures AFTER it must surface as warnings, never as operation
// failure — a 500 here would misreport committed state (the user thinks the
// answer failed; a retry gets a confusing 409).
function refreshDigestAndMirror(dataDir, slug) {
  const warnings = [];
  try {
    generateDigest(dataDir, slug);
  } catch (err) {
    warnings.push(`digest for "${slug}" not regenerated: ${err.message} — ` +
      `answers\\${slug}.md is stale until the next successful update`);
    const entry = readProjects(dataDir).projects[slug];
    if (entry && entry.mirror) {
      warnings.push(`mirror for "${slug}" skipped because the digest could not be regenerated`);
    }
    return warnings;
  }
  warnings.push(...mirrorDigest(dataDir, slug));
  return warnings;
}

function setStatus(dataDir, id, { status, superseded_by, returned_reason } = {}) {
  if (!STATUS_TARGETS.includes(status)) {
    fail('VALIDATION', `"status" must be one of ${STATUS_TARGETS.join(', ')}`);
  }
  if (superseded_by !== undefined && superseded_by !== null && !validateId(superseded_by)) {
    fail('VALIDATION', '"superseded_by" must be a valid request id (letters, digits, hyphens)');
  }
  if (status === 'returned' &&
      (typeof returned_reason !== 'string' || returned_reason.trim() === '')) {
    fail('VALIDATION', 'returning a request requires a non-empty "returned_reason" string');
  }
  const { body, filePath, archived } = readRequestFile(dataDir, id);
  if (archived) {
    fail('CONFLICT', `request "${id}" is archived; restore it by moving the file out of requests\\archive manually`);
  }
  if (status === 'returned' && body.status !== 'open') {
    fail('CONFLICT', `only open requests can be returned for rewrite (status is "${body.status}")`);
  }

  body.status = status;
  if (status === 'superseded') {
    body.superseded_by = superseded_by !== undefined && superseded_by !== null
      ? superseded_by
      : (body.superseded_by !== undefined ? body.superseded_by : null);
  } else if (status === 'open') {
    // Reopen: prior answer object and returned_reason are kept in place
    // (history); the request drops out of the digest via status. A stale
    // superseded_by pointer is cleared.
    body.superseded_by = null;
  } else if (status === 'returned') {
    body.returned_reason = returned_reason;
  }
  atomicWriteFile(filePath, JSON.stringify(body, null, 2) + '\n');

  const mirror_warnings = refreshDigestAndMirror(dataDir, body.project);
  return { request: { ...body, id }, mirror_warnings };
}

// Move a settled request into requests\archive. Digest content is unaffected
// (digests scan both directories); the request disappears from the app.
function archiveRequest(dataDir, id) {
  const { body, filePath, archived } = readRequestFile(dataDir, id);
  if (archived) {
    fail('CONFLICT', `request "${id}" is already archived`);
  }
  if (!ARCHIVABLE_STATUSES.includes(body.status)) {
    fail('CONFLICT',
      `only ${ARCHIVABLE_STATUSES.join(', ')} requests can be archived (status is "${body.status}")`);
  }
  fs.mkdirSync(archiveDir(dataDir), { recursive: true });
  const dest = path.join(archiveDir(dataDir), `${id}.json`);
  try {
    fs.renameSync(filePath, dest);
  } catch (err) {
    fail('IO', `failed to archive request "${id}": ${err.message}`);
  }
  return { request: { ...body, id, archived: true } };
}

// ---------------------------------------------------------------------------
// Digest + mirror
// ---------------------------------------------------------------------------

function oneLine(text) {
  return String(text).replace(/\s*\r?\n\s*/g, ' ').trim();
}

function labelFor(response, key) {
  if (response && Array.isArray(response.options)) {
    const opt = response.options.find((o) => o && o.key === key);
    if (opt && typeof opt.label === 'string' && opt.label !== '') return opt.label;
  }
  return key;
}

function renderAnswerValue(request) {
  const { answer, response } = request;
  if (!answer || typeof answer !== 'object' || answer.value === undefined) {
    if (request.status === 'superseded') {
      return `(none — superseded by ${request.superseded_by || 'n/a'})`;
    }
    return '(none)';
  }
  const value = answer.value;
  const type = response && response.type;
  try {
    if (type === 'choice' && typeof value === 'string') {
      return labelFor(response, value);
    }
    if ((type === 'multi_select' || type === 'checklist') && Array.isArray(value)) {
      if (value.length === 0) return '(none selected)';
      return value.map((k) => labelFor(response, k)).join(', ');
    }
    if (type === 'text' && typeof value === 'string') {
      return oneLine(value);
    }
    if (type === 'approval' && value && typeof value === 'object') {
      return value.decision === 'approve' ? 'Approved' : 'Rejected';
    }
  } catch (_) {
    // fall through to raw rendering
  }
  return JSON.stringify(value);
}

function digestEntryLines(r, sortKey) {
  const lines = [];
  const stamp = sortKey(r);
  const day = stamp ? stamp.slice(0, 10) : 'unknown-date';
  lines.push(`## ${day} — ${oneLine(r.title)}  (id: ${r.id})`);
  const statusText = r.status === 'superseded'
    ? `superseded — see ${r.superseded_by || 'n/a'}`
    : r.status;
  lines.push(`- **Asked by:** ${r.agent ? oneLine(r.agent) : 'unknown'} — **Status:** ${statusText}`);
  lines.push(`- **Ask:** ${r.ask !== undefined ? oneLine(r.ask) : '(none)'}`);
  lines.push(`- **Answer:** ${renderAnswerValue(r)}`);
  if (r.answer && typeof r.answer === 'object' && typeof r.answer.notes === 'string' && r.answer.notes !== '') {
    lines.push(`- **Notes:** ${oneLine(r.answer.notes)}`);
  }
  lines.push('');
  return lines;
}

function digestHeaderLines(dataDir, name, { archive = false } = {}) {
  return [
    `# Agent Inbox — answered requests for ${name}${archive ? ' (archive)' : ''}`,
    '',
    '> Generated by Agent Inbox. Do not edit; edits will be overwritten.',
    `> Machine-readable source of truth: ${path.join(dataDir, 'requests')}${path.sep}<id>.json`,
    '',
  ];
}

// Renders the main digest (newest DIGEST_MAX_ENTRIES entries) and, when older
// entries exist, an archive digest holding everything older. Scans both
// requests\ and requests\archive so archiving a request never changes content.
function renderDigests(dataDir, slug) {
  const registry = readProjects(dataDir);
  const entry = registry.projects[slug];
  const name = entry && typeof entry.name === 'string' && entry.name !== '' ? entry.name : slug;
  const scan = listRequestsForDigest(dataDir);
  if (scan.unreadable) {
    // Refuse: regenerating from a failed scan would atomically rewrite the
    // digest (and any mirror) to empty, wiping visible answer history over
    // a transient permission error.
    fail('IO', `refusing to regenerate digest for "${slug}": requests directory unreadable`);
  }
  const items = scan.requests.filter(
    (r) => r.project === slug && (r.status === 'answered' || r.status === 'superseded'),
  );
  const sortKey = (r) =>
    (r.answer && typeof r.answer === 'object' && typeof r.answer.answered_at === 'string'
      ? r.answer.answered_at
      : typeof r.created === 'string' ? r.created : '');
  items.sort((a, b) => sortKey(b).localeCompare(sortKey(a))); // newest first

  const recent = items.slice(0, DIGEST_MAX_ENTRIES);
  const older = items.slice(DIGEST_MAX_ENTRIES);

  const mainLines = digestHeaderLines(dataDir, name);
  if (recent.length === 0) {
    mainLines.push('_No answered requests yet._');
    mainLines.push('');
  }
  for (const r of recent) mainLines.push(...digestEntryLines(r, sortKey));
  if (older.length > 0) {
    mainLines.push('---');
    mainLines.push(`_${older.length} older ${older.length === 1 ? 'entry is' : 'entries are'} in ` +
      `${path.join(answersDir(dataDir), `${slug}-archive.md`)} (kept in the data store; not mirrored into project repos)._`);
    mainLines.push('');
  }

  let archiveMarkdown = null;
  if (older.length > 0) {
    const archiveLines = digestHeaderLines(dataDir, name, { archive: true });
    for (const r of older) archiveLines.push(...digestEntryLines(r, sortKey));
    archiveMarkdown = archiveLines.join('\n');
  }

  return { main: mainLines.join('\n'), archive: archiveMarkdown, archiveCount: older.length };
}

function generateDigest(dataDir, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    fail('VALIDATION', `invalid project slug "${slug}"`);
  }
  const { main, archive } = renderDigests(dataDir, slug);
  fs.mkdirSync(answersDir(dataDir), { recursive: true });
  const digestPath = path.join(answersDir(dataDir), `${slug}.md`);
  atomicWriteFile(digestPath, main);
  const archivePath = path.join(answersDir(dataDir), `${slug}-archive.md`);
  if (archive !== null) {
    atomicWriteFile(archivePath, archive);
  } else if (fs.existsSync(archivePath)) {
    // No overflow any more (e.g. entries deleted by hand) — drop the stale file.
    try {
      fs.unlinkSync(archivePath);
    } catch (_) {
      // Can't delete it (locked?) — overwrite with an explicit stub so it
      // never silently presents dead data.
      try {
        atomicWriteFile(archivePath,
          '# (empty) — this archive is stale and could not be deleted\n\n' +
          '> Generated by Agent Inbox. The entries previously here no longer exist;\n' +
          '> this file could not be removed. It is safe to delete manually.\n');
      } catch (_) {
        // both delete and overwrite failed; leave as-is
      }
    }
  }
  return { path: digestPath, markdown: main, archivePath: archive !== null ? archivePath : null };
}

// Mirror the project digest into the project's own repo. NEVER throws;
// every failure becomes a warning string.
function mirrorDigest(dataDir, slug) {
  const warnings = [];
  try {
    const registry = readProjects(dataDir);
    const entry = registry.projects[slug];
    if (!entry || typeof entry !== 'object' || !entry.mirror) return warnings;
    if (typeof entry.mirror !== 'string') {
      warnings.push(`project "${slug}": "mirror" must be a string path relative to the repo`);
      return warnings;
    }
    if (typeof entry.repo !== 'string' || entry.repo.trim() === '') {
      warnings.push(`project "${slug}": mirror configured but "repo" is missing`);
      return warnings;
    }
    const repoRoot = path.resolve(entry.repo);
    const mirrorRel = entry.mirror.replace(/[\\/]+/g, path.sep); // normalize \ and /
    const target = path.resolve(repoRoot, mirrorRel);
    if (!target.startsWith(repoRoot + path.sep)) {
      warnings.push(`project "${slug}": mirror path "${entry.mirror}" escapes the repo (${entry.repo}); not written`);
      return warnings;
    }
    let repoStat;
    try {
      repoStat = fs.statSync(repoRoot);
    } catch (err) {
      warnings.push(err.code === 'ENOENT'
        ? `project "${slug}": repo directory not found (${entry.repo}); mirror not written`
        : `project "${slug}": repo not accessible: ${err.message}; mirror not written`);
      return warnings;
    }
    if (!repoStat.isDirectory()) {
      warnings.push(`project "${slug}": repo path is not a directory (${entry.repo}); mirror not written`);
      return warnings;
    }
    // Only the main (capped) digest is mirrored; the archive digest stays in
    // the data store and the main digest's footer points at it.
    const { main } = renderDigests(dataDir, slug);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWriteFile(target, main);
  } catch (err) {
    warnings.push(`project "${slug}": mirror write failed: ${err.message}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Bootstrap + state
// ---------------------------------------------------------------------------

function ensureStore(dataDir, protocolSourcePath) {
  const created = !fs.existsSync(dataDir);
  fs.mkdirSync(requestsDir(dataDir), { recursive: true });
  fs.mkdirSync(answersDir(dataDir), { recursive: true });

  if (!fs.existsSync(projectsPath(dataDir))) {
    atomicWriteFile(
      projectsPath(dataDir),
      JSON.stringify({ schema_version: 1, projects: {} }, null, 2) + '\n',
    );
  }

  let protocolSynced = false;
  if (protocolSourcePath && !fs.existsSync(protocolSourcePath)) {
    console.warn(`[agent-inbox] PROTOCOL.md source not found at ${protocolSourcePath} — data-store copy NOT synced`);
  }
  if (protocolSourcePath && fs.existsSync(protocolSourcePath)) {
    const source = fs.readFileSync(protocolSourcePath);
    const dest = path.join(dataDir, 'PROTOCOL.md');
    let differs = true;
    if (fs.existsSync(dest)) {
      differs = !source.equals(fs.readFileSync(dest)); // byte compare; repo copy is canonical
    }
    if (differs) {
      atomicWriteFile(dest, source.toString('utf8'));
      protocolSynced = true;
    }
  }

  // Regenerate every project digest on boot (covers out-of-app file edits).
  // One bad slug must not prevent server start for all the others.
  const slugs = new Set();
  const registry = readProjects(dataDir);
  for (const slug of Object.keys(registry.projects)) {
    if (SLUG_RE.test(slug)) {
      slugs.add(slug);
    } else {
      console.warn(`[agent-inbox] ignoring invalid project slug "${slug}" in projects.json (must match ^[a-z0-9-]+$)`);
    }
  }
  for (const r of listRequestsForDigest(dataDir).requests) slugs.add(r.project);
  for (const slug of slugs) {
    try {
      generateDigest(dataDir, slug);
    } catch (err) {
      console.warn(`[agent-inbox] boot digest regeneration failed for "${slug}": ${err.message}`);
    }
  }

  return { created, protocolSynced };
}

function getState(dataDir) {
  const { requests, invalid } = listRequests(dataDir);
  const { registry, error } = readProjectsRaw(dataDir);
  if (error) invalid.push({ file: 'projects.json', error });
  return { projects: registry, requests, invalid };
}

module.exports = {
  StoreError,
  RESPONSE_TYPES,
  OPTION_TYPES,
  atomicWriteFile,
  validateId,
  generateId,
  ensureStore,
  readProjects,
  listRequests,
  readRequest,
  createRequest,
  validateAnswerShape,
  answerRequest,
  setStatus,
  archiveRequest,
  lintClarity,
  generateDigest,
  mirrorDigest,
  getState,
};
