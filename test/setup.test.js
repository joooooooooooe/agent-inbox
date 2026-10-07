'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('../lib/store');
const setup = require('../setup');

const tmpDirs = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-setup-test-'));
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

test('renderTemplate replaces every {{DATA_DIR}} token and nothing else', () => {
  assert.equal(
    store.renderTemplate('a {{DATA_DIR}} b {{DATA_DIR}}/requests c', 'C:\\x\\.agent-inbox'),
    'a C:/x/.agent-inbox b C:/x/.agent-inbox/requests c',
  );
  assert.equal(store.renderTemplate('no tokens here', 'C:\\x'), 'no tokens here');
  assert.equal(store.renderTemplate('', 'C:\\x'), '');
  // Not a regex replace: special characters in the path survive verbatim.
  assert.equal(store.renderTemplate('{{DATA_DIR}}', 'C:\\a$b\\$&'), 'C:/a$b/$&');
});

test('rendered skill and protocol use forward slashes only, even for a Windows data dir', () => {
  const dataDir = 'C:\\Users\\someone\\.agent-inbox';
  const skill = store.renderTemplate(fs.readFileSync(path.join(__dirname, '..', 'skill', 'agent-inbox', 'SKILL.md'), 'utf8'), dataDir);
  const protocol = store.renderTemplate(fs.readFileSync(path.join(__dirname, '..', 'protocol', 'PROTOCOL.md'), 'utf8'), dataDir);
  assert.ok(skill.includes('C:/Users/someone/.agent-inbox/tools/agent.js'));
  assert.ok(skill.includes('C:/Users/someone/.agent-inbox/requests/'));
  assert.ok(!skill.includes('\\'), 'no backslash anywhere in the rendered skill');
  // The protocol's markdown tables escape pipes as `\|`; nothing else may be a backslash.
  assert.ok(!/\\(?!\|)/.test(protocol), 'no backslash path separators in the rendered protocol');
});

test('runSetup against an explicit homeDir: seeds store, installs rendered skill, idempotent', () => {
  const homeDir = makeTmp(); // never the real home directory
  const first = setup.runSetup({ homeDir });

  const dataDir = path.join(homeDir, '.agent-inbox');
  assert.equal(first.dataDir, dataDir);
  assert.equal(first.boot.created, true);
  assert.equal(first.skillStatus, 'installed');

  // Data store seeded with a rendered protocol.
  assert.ok(fs.statSync(path.join(dataDir, 'requests')).isDirectory());
  const protocol = fs.readFileSync(path.join(dataDir, 'PROTOCOL.md'), 'utf8');
  assert.ok(!protocol.includes('{{DATA_DIR}}'));
  assert.ok(protocol.includes(dataDir.replace(/\\/g, '/')));

  // Skill installed under <home>\.claude\skills, rendered for this machine.
  const skillDest = path.join(homeDir, '.claude', 'skills', 'agent-inbox', 'SKILL.md');
  assert.equal(first.skillDest, skillDest);
  const skill = fs.readFileSync(skillDest, 'utf8');
  assert.ok(!skill.includes('{{DATA_DIR}}'));
  assert.ok(skill.includes(`${dataDir.replace(/\\/g, '/')}/PROTOCOL.md`));
  assert.match(skill, /^---\r?\nname: agent-inbox/, 'frontmatter intact');
  assert.equal(fs.readFileSync(first.sharedSkillDest, 'utf8'), skill);
  assert.ok(fs.existsSync(path.join(first.toolRoot, 'agent.js')));
  const { spawnSync } = require('node:child_process');
  const checked = spawnSync(process.execPath, [path.join(first.toolRoot, 'agent.js'), 'check', 'demo', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).submissions.total, 0);

  // Re-run: nothing to do.
  const second = setup.runSetup({ homeDir });
  assert.equal(second.boot.created, false);
  assert.equal(second.boot.protocolSynced, false);
  assert.equal(second.skillStatus, 'already current');

  // Drifted skill gets updated back to the rendered source.
  fs.writeFileSync(skillDest, 'stale local edit', 'utf8');
  const third = setup.runSetup({ homeDir });
  assert.equal(third.skillStatus, 'updated');
  assert.equal(fs.readFileSync(skillDest, 'utf8'), skill);

  assert.throws(() => setup.runSetup({}), /homeDir/);
});
