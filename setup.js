'use strict';

// Agent Inbox — one-shot machine setup. Zero npm dependencies, sync fs.
//
//   node setup.js
//
// Idempotent and safe to re-run:
//   1. creates/seeds the data store at <home>\.agent-inbox (rendered PROTOCOL.md);
//   2. installs the Claude skill to <home>\.claude\skills\agent-inbox\SKILL.md;
//   3. prints next steps.
//
// The core takes explicit paths so tests never touch the real home directory;
// only the CLI entry point uses os.homedir().

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('./lib/store');

const PROTOCOL_SOURCE = path.join(__dirname, 'protocol', 'PROTOCOL.md');
const SKILL_SOURCE = path.join(__dirname, 'skill', 'agent-inbox', 'SKILL.md');

// Render + install one templated file; returns 'installed' | 'updated' | 'already current'.
function installRenderedFile(sourcePath, destPath, dataDir) {
  const rendered = store.renderTemplate(fs.readFileSync(sourcePath, 'utf8'), dataDir);
  let status = 'installed';
  if (fs.existsSync(destPath)) {
    status = Buffer.from(rendered, 'utf8').equals(fs.readFileSync(destPath))
      ? 'already current'
      : 'updated';
  }
  if (status !== 'already current') {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    store.atomicWriteFile(destPath, rendered);
  }
  return status;
}

// Core: everything setup does, against explicit paths. Never reads os.homedir().
function runSetup({ homeDir }) {
  if (typeof homeDir !== 'string' || homeDir.trim() === '') {
    throw new Error('runSetup requires a homeDir');
  }
  const dataDir = path.join(homeDir, '.agent-inbox');
  const boot = store.ensureStore(dataDir, PROTOCOL_SOURCE);
  const skillDest = path.join(homeDir, '.claude', 'skills', 'agent-inbox', 'SKILL.md');
  const skillStatus = installRenderedFile(SKILL_SOURCE, skillDest, dataDir);
  return { dataDir, boot, skillDest, skillStatus };
}

function main() {
  const result = runSetup({ homeDir: os.homedir() });
  const { dataDir, boot, skillDest, skillStatus } = result;

  console.log('Agent Inbox setup');
  console.log('-----------------');
  console.log(`Data store:   ${dataDir}  (${boot.created ? 'created' : 'already existed'})`);
  console.log(`PROTOCOL.md:  ${boot.protocolSynced ? 'synced (rendered for this machine)' : 'already current'}`);
  console.log(`Claude skill: ${skillDest}  (${skillStatus})`);
  console.log('');
  console.log('Next steps');
  console.log(`  1. Register this machine's projects: edit ${path.join(dataDir, 'projects.json')}`);
  console.log('     (slug -> { "name", "repo", optional "mirror" relative to repo — see README).');
  console.log(`  2. For Codex-driven repos, paste the "Asking the operator (Agent Inbox)" snippet from`);
  console.log(`     ${path.join(dataDir, 'PROTOCOL.md')} (section 5) into each repo's AGENTS.md.`);
  console.log('     (Claude picks the skill up machine-wide automatically.)');
  console.log('  3. Run start-inbox.cmd (or: node server.js) and open http://127.0.0.1:7717');
  console.log('  4. Optional: auto-start via Task Scheduler — see README.md.');
  console.log('');
  console.log('Safe to re-run any time; it only updates what drifted.');
}

if (require.main === module) main();

module.exports = { runSetup, installRenderedFile };
