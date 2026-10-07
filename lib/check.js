'use strict';

const path = require('node:path');
const store = require('./store');
const intake = require('./submissions');
const clip = (s, n = 240) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
function check(dir, project, options = {}) {
  if (typeof project !== 'string' || !/^[a-z0-9-]+$/.test(project)) throw new store.StoreError('VALIDATION', 'invalid project slug');
  const limit = options.limit ?? 10, offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(offset) || offset < 0) {
    throw new store.StoreError('VALIDATION', 'limit must be 1–20; offset must be non-negative');
  }
  const since = options.since ? Date.parse(options.since) : null;
  if (since !== null && Number.isNaN(since)) throw new store.StoreError('VALIDATION', 'invalid since timestamp');
  const words = String(options.topic || '').toLowerCase().split(/\s+/).filter(Boolean);
  const section = options.section || 'all';
  if (!['all', 'replies', 'next_check', 'submissions', 'open_questions'].includes(section)) throw new store.StoreError('VALIDATION', 'invalid section');
  const matches = (s) => !words.length || words.some((w) =>
    `${s.title} ${s.ask || s.message} ${Array.isArray(s.events) ? s.events.filter((e) => e?.actor === 'operator').map((e) => e.message).join(' ') : ''} ${s.answer ? JSON.stringify(s.answer) : ''}`.toLowerCase().includes(w));
  const live = store.listAllRequests(dir);
  const { submissions, invalid } = intake.list(dir);
  const requestSummary = (r) => ({ id: r.id, title: clip(r.title, 100), status: r.status,
    preview: r.status === 'answered' ? clip(JSON.stringify(r.answer)) : r.status === 'returned' ? clip(r.returned_reason) : clip(r.ask),
    file: path.join(dir, 'requests', r.archived ? 'archive' : '', `${r.id}.json`) });
  const submissionSummary = (s) => ({ id: s.id, title: clip(s.title, 100), priority: s.priority,
    status: s.status, revision: s.revision, preview: clip(s.message),
    latest_operator_reply: clip(s.events.filter((e) => e.actor === 'operator').at(-1)?.message),
    claim: intake.activeClaim(s) ? { owner: s.claim.owner, expires_at: s.claim.expires_at } : null,
    work: s.work ? { owner: clip(s.work.owner, 80), reference: clip(s.work.reference, 160) } : null,
    linked_questions: s.request_ids.length,
    broken_links: s.request_ids.filter((id) => { try { store.readRequest(dir, id); return false; } catch (_) { return true; } }).length,
    file: path.join(dir, 'submissions', `${s.id}.json`) });
  const page = (rows, name, budget) => {
    const size = section === 'all' || section === name ? budget : 0;
    return { total: rows.length, items: rows.slice(offset, offset + size),
      next_offset: rows.length > offset + size ? offset + size : null };
  };
  // Explicitly awaited ids bypass all discovery filters and pagination, including
  // archived and withdrawn records. A retained old answer never overrides status.
  if (!Array.isArray(options.requests || []) || (options.requests || []).length > 20) throw new store.StoreError('VALIDATION', 'at most 20 watched request ids');
  const watched = (options.requests || []).map((id) => {
    const r = store.readRequest(dir, id);
    if (r.project !== project) throw new store.StoreError('VALIDATION', `watched request ${id} belongs to ${r.project}`);
    return requestSummary(r);
  });
  const replies = live.requests.filter((r) => r.project === project && ['answered', 'returned'].includes(r.status) && matches(r) &&
    (r.status === 'returned' || since === null || Date.parse(r.answer?.answered_at) >= since))
    .sort((a, b) => (a.status === 'returned' ? 0 : 1) - (b.status === 'returned' ? 0 : 1) ||
      String(b.answer?.answered_at || b.created).localeCompare(String(a.answer?.answered_at || a.created)));
  const belongs = submissions.filter((s) => s.project === project);
  const rank = { next_check: 0, planned: 1, later: 2 };
  const readyWaiting = (s) => s.status === 'waiting' && intake.waitingReady(dir, s);
  const actionable = belongs.filter((s) => ['submitted', 'checking'].includes(s.status) || readyWaiting(s));
  const nextCheck = actionable.filter((s) => s.priority === 'next_check').sort((a, b) => a.created.localeCompare(b.created));
  const normal = actionable.filter((s) => s.priority !== 'next_check' && matches(s) &&
    (s.priority !== 'later' || options.includeLater || words.length))
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.created.localeCompare(b.created));
  const unknown = submissions.filter((s) => s.project === 'unassigned' && !['closed', 'withdrawn'].includes(s.status));
  const nextPage = page(nextCheck.map(submissionSummary), 'next_check', limit);
  const normalBudget = section === 'all' ? Math.max(0, limit - nextPage.items.length) : limit;
  const problems = [...live.invalid, ...invalid];
  return { project, checked_at: new Date().toISOString(), watched,
    replies: page(replies.map(requestSummary), 'replies', section === 'all' ? Math.min(5, limit) : limit),
    next_check: nextPage, submissions: page(normal.map(submissionSummary), 'submissions', normalBudget),
    open_questions: page(live.requests.filter((r) => r.project === project && r.status === 'open' && matches(r)).map(requestSummary), 'open_questions', section === 'all' ? Math.min(5, limit) : limit),
    deferred_or_routed: { total: belongs.filter((s) => ['routed', 'deferred'].includes(s.status) || s.priority === 'later').length },
    unassigned: { total: unknown.length, routing_only: true, preview: unknown.slice(0, 3).map(submissionSummary) },
    problems: { total: problems.length, items: problems.slice(0, 5).map((p) => ({ file: p.file, error: clip(p.error) })) },
    guidance: 'Open only relevant named files. Page with --section <name> --offset <next_offset>. Next-check needs a checkpoint response; workers forward outside their remit. Unassigned is routing-only for owners. Search topic/history before re-asking; previews are not exhaustive standing direction.' };
}
module.exports = { check };
