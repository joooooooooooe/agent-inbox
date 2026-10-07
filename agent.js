'use strict';

// Also installed under the data store: this helper works with the web app closed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const intake = require('./lib/submissions');
const { check } = require('./lib/check');
const HELP = `Agent Inbox: one project check, details only when relevant.
  node agent.js check <project> [--topic words] [--request id (repeatable)]
      [--since ISO-time] [--section replies|next_check|submissions|open_questions]
      [--offset 0] [--limit 10] [--include-later]
  node agent.js show <submission-id>
  node agent.js claim <id> --owner session-name --revision N
  node agent.js renew <id> --owner session-name --token T --revision N
  node agent.js respond <id> --owner session-name --token T --revision N
      --status checking|waiting|routed|deferred|closed --message-file UTF8-file
      [--work-owner name --work-reference repo-relative-path]
      [--request id (repeatable, linked Needs-you questions) | --clear-requests]
  node agent.js assign <id> --owner session-name --token T --revision N
      --project slug --message-file UTF8-file
  All commands accept --data-dir path; default is ~/.agent-inbox.
Claims last 30 minutes. Claim/renew returns the current revision and token.
Read the original text, operator replies, and linked answers before acting.
Only owners triage beyond assigned work. Posting authorizes checking/routing;
implementation authority follows the message and existing project rules.
Routed needs a work owner/reference. Waiting needs a linked open human question.
Closed means the requested outcome is met, not merely scheduled.
Do not put agent findings in operator answer digests. No agent is auto-launched.`;
function main(args = process.argv.slice(2)) {
  const command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(HELP); return; }
  const target = args.shift();
  const opts = {}, requests = [];
  const flags = new Set(['topic', 'request', 'since', 'section', 'offset', 'limit', 'data-dir', 'owner', 'revision', 'token', 'status', 'message-file', 'work-owner', 'work-reference', 'project']);
  while (args.length) {
    const key = args.shift();
    if (key === '--include-later') { opts.includeLater = true; continue; }
    if (key === '--clear-requests') { opts.clearRequests = true; continue; }
    if (!key?.startsWith('--') || !flags.has(key.slice(2)) || !args.length) throw new Error(`invalid argument ${key}; use --help`);
    const value = args.shift();
    if (key === '--request') requests.push(value); else opts[key.slice(2)] = value;
  }
  const dir = opts['data-dir'] || process.env.AGENT_INBOX_DATA_DIR || path.join(os.homedir(), '.agent-inbox');
  if (command === 'check') {
    console.log(JSON.stringify(check(dir, target, { topic: opts.topic, requests, since: opts.since,
      section: opts.section, offset: opts.offset === undefined ? 0 : Number(opts.offset), limit: opts.limit === undefined ? 10 : Number(opts.limit), includeLater: opts.includeLater }), null, 2));
    return;
  }
  if (command === 'show') { console.log(JSON.stringify(intake.read(dir, target), null, 2)); return; }
  const input = { owner: opts.owner, token: opts.token, expected_revision: Number(opts.revision) };
  if (['respond', 'assign'].includes(command)) {
    if (!opts['message-file']) throw new Error('--message-file is required');
    input.message = fs.readFileSync(opts['message-file'], 'utf8').replace(/^\uFEFF/, '');
    input.status = opts.status;
    input.project = opts.project;
    if (opts.clearRequests && requests.length) throw new Error('choose --clear-requests or --request');
    if (opts.clearRequests || requests.length) input.request_ids = requests;
    if (opts['work-owner'] || opts['work-reference']) input.work = { owner: opts['work-owner'], reference: opts['work-reference'] };
  }
  if (!['claim', 'renew', 'respond', 'assign'].includes(command)) throw new Error(`unknown command ${command}; use --help`);
  console.log(JSON.stringify(intake[command](dir, target, input), null, 2));
}
if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { main };
