'use strict';

// Agent Inbox — one-command demo.
//
//   node demo.js            seed a throwaway inbox, start the server, open it
//   node demo.js --keep     keep the demo store afterwards (.demo-store/)
//   node demo.js --no-open  don't launch a browser
//
// Everything lands in a temporary directory that is deleted on exit. The real
// data store at <home>/.agent-inbox is never read, written, or looked at.
//
// The sample requests are filed through lib/store's own createRequest, the
// same entry point the app and the tests use, so they are valid by
// construction rather than by hand-copying — and answering one really does
// generate an answers digest on disk.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const store = require('./lib/store');
const intake = require('./lib/submissions');

const PROTOCOL_SOURCE = path.join(__dirname, 'protocol', 'PROTOCOL.md');
const PORT = Number(process.env.AGENT_INBOX_PORT) || 7718; // not 7717: a real inbox may be up

const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');
const OPEN_BROWSER = !args.has('--no-open');

const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECTS = {
  schema_version: 1,
  projects: {
    orchard: { name: 'Orchard' },
    // Pointed at this repo, so the markdown path in the request below resolves
    // to a document that really exists and can be opened from the card.
    'agent-inbox': { name: 'Agent Inbox', repo: __dirname },
  },
};

// Each entry is [hoursAgo, request]. Between them they cover every response
// type, both urgencies that matter, and the clarity lint firing.
const REQUESTS = [
  [18, {
    project: 'orchard',
    agent: 'claude-code',
    title: 'Add a setting for showing the full text?',
    ask: 'Should people be able to choose whether the full text is shown, or should it always be shown?',
    background: [
      'Some people find long text overwhelming; others want everything visible at once.',
      'Either choice ships this week — the cost difference is small.',
      "If you don't decide, this part of the work stays stopped.",
    ],
    urgency: 'high',
    blocking: true,
    response: {
      type: 'choice',
      options: [
        {
          key: 'setting',
          label: 'Add the setting',
          description: 'People choose for themselves; one more thing to understand in the settings screen.',
        },
        {
          key: 'always',
          label: 'Always show the full text',
          description: 'Simpler and nothing to learn, but long entries will crowd the screen.',
        },
      ],
    },
    on_answered: ['Will build the chosen behaviour and record the decision in the project docs.'],
    technical_context: [
      'Would live in the settings panel; affects the card renderer.',
      'Relates to the S1 workstream and the §3.5 exception in the spec.',
    ],
  }],

  [17, {
    project: 'orchard',
    agent: 'codex',
    title: 'S1 blocked on D-103 exception scope',
    ask: 'S1 defines 4 load-bearing parameters structurally within the blast radius of the §3.5 exception from D-103 (see `src/core/params.ts`). Blocked pending your ruling.',
    background: ['Needs a decision.'],
    urgency: 'high',
    blocking: true,
    response: { type: 'approval' },
    // Deliberately awful: this is what the clarity lint is for. In the app it
    // gets a CLARITY badge and a one-click "Return for rewrite".
  }],

  [20, {
    project: 'agent-inbox',
    agent: 'claude-code',
    title: 'What should the "put it away" button be called?',
    ask: 'Once a request has been answered, what should the button that files it out of the list say?',
    background: ['This is only the wording on one button — nothing else changes.'],
    urgency: 'low',
    blocking: false,
    response: {
      type: 'choice',
      options: [
        { key: 'archive', label: 'Archive', description: 'Familiar from email.' },
        { key: 'file-away', label: 'File away', description: 'Plainer, slightly longer.' },
        { key: 'done', label: 'Done', description: 'Shortest, but says less about where it went.' },
      ],
    },
  }],

  [26, {
    project: 'orchard',
    agent: 'claude-code',
    title: 'Which extras should a saved file include?',
    ask: 'When someone saves their work to share it, which extras should travel with it?',
    background: [
      'Each extra makes the file a little larger but saves the other person setting things up again.',
      'Pick any combination; none of them is required.',
    ],
    urgency: 'medium',
    blocking: false,
    response: {
      type: 'multi_select',
      options: [
        { key: 'notes', label: 'Personal notes', description: 'Anything typed into the notes box.' },
        { key: 'layout', label: 'Screen layout', description: 'Where the panels were positioned.' },
        { key: 'history', label: 'Recent history', description: 'The last 50 changes, which can be large.' },
      ],
    },
  }],

  [30, {
    project: 'agent-inbox',
    agent: 'codex',
    title: 'What should the welcome screen say?',
    ask: 'What one sentence should greet someone opening this for the first time?',
    background: ['It appears once, above an empty list, and can be changed later.'],
    urgency: 'low',
    blocking: false,
    response: { type: 'text' },
    technical_context: [
      // A real path in this repo, with a section: clicking it opens the
      // document at that heading.
      'Wording follows the tone argued for in '
        + 'docs/2026-08-16-project-tracking-design.md#the-recommendation-up-front.',
    ],
  }],
];

// Filed 44 hours ago, answered 41 hours ago — gives the demo a real answers
// digest and a populated "Answered" tab.
const ANSWERED = [44, 41, {
  project: 'orchard',
  agent: 'claude-code',
  title: 'Which way should the list be sorted?',
  ask: 'Should the list put the most urgent thing first, or the oldest thing first?',
  background: ['Whichever is chosen, the other stays available as a sort option.'],
  urgency: 'medium',
  blocking: false,
  response: {
    type: 'choice',
    options: [
      { key: 'urgent', label: 'Most urgent first', description: 'The thing most likely to be blocking someone is at the top.' },
      { key: 'oldest', label: 'Oldest first', description: 'Nothing can sit forgotten at the bottom.' },
    ],
  },
}, 'urgent', 'Urgent first, but never let anything sit unanswered longer than a week.'];

// ---------------------------------------------------------------------------
// Seed + run
// ---------------------------------------------------------------------------

function seed(dataDir) {
  store.ensureStore(dataDir, PROTOCOL_SOURCE);
  store.atomicWriteFile(
    path.join(dataDir, 'projects.json'),
    JSON.stringify(PROJECTS, null, 2) + '\n',
  );

  for (const [hours, request] of REQUESTS) {
    store.createRequest(dataDir, request, ago(hours));
  }

  const [filedHours, answeredHours, request, value, notes] = ANSWERED;
  const created = store.createRequest(dataDir, request, ago(filedHours));
  store.answerRequest(dataDir, created.id, { value, notes }, ago(answeredHours));

  intake.create(dataDir, { project: 'orchard', title: 'Make sure saved messages are searchable',
    message: 'Can people find an old message by its text? Check whether we have this or need to plan it.', priority: 'planned' }, ago(2));
  const submission = intake.create(dataDir, { project: 'agent-inbox', title: 'Can I read linked documents?',
    message: 'Check whether document links already open inside the Inbox.', priority: 'next_check' }, ago(1));
  const claimed = intake.claim(dataDir, submission.id, { owner: 'demo-agent', expected_revision: 1 });
  intake.respond(dataDir, submission.id, { owner: claimed.claim.owner, token: claimed.claim.token,
    expected_revision: claimed.revision, status: 'closed', message: 'Yes. Document links open in the built-in reader. See README.md#reading-what-a-question-refers-to for an example.' });

  return REQUESTS.length + 1;
}

function removeStore(dataDir) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`\n(could not remove the demo store at ${dataDir}: ${err.message})`);
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open'
      : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* no browser is not an error worth reporting */ });
    child.unref();
  } catch (_) {
    // Opening a browser is a convenience; the URL is printed regardless.
  }
}

function main() {
  const dataDir = KEEP
    ? path.join(__dirname, '.demo-store')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-demo-'));

  if (KEEP) fs.rmSync(dataDir, { recursive: true, force: true });

  const count = seed(dataDir);

  console.log('Agent Inbox — demo');
  console.log('------------------');
  console.log(`Seeded ${count} sample requests into a throwaway store.`);
  console.log(`Store:  ${dataDir}`);
  console.log(KEEP
    ? '        (kept, because of --keep — delete it whenever you like)'
    : '        (temporary — deleted when you stop this with Ctrl+C)');
  console.log('');
  console.log('Your own inbox is untouched: this never reads or writes ~/.agent-inbox.');
  console.log('');
  console.log('Things worth trying:');
  console.log('  • Send a message to agents, then find it under For agents.');
  console.log('  • Open Updates to read the sample agent response and mark it read.');
  console.log('  • Answer the top request — watch it leave "Needs you" and land in "Answered".');
  console.log('  • Open "S1 blocked on D-103 exception scope": it is written in agent jargon,');
  console.log('    so it carries a CLARITY badge. Use "Return for rewrite" to bounce it back.');
  console.log('  • After answering anything, look at answers/orchard.md in the store above —');
  console.log('    that generated file is what the agent reads to learn your decision.');
  console.log('');

  // Child process rather than require(): server.js reads its data dir once, at
  // require time, so it has to be given the environment before it starts.
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, AGENT_INBOX_DATA_DIR: dataDir, AGENT_INBOX_PORT: String(PORT) },
    stdio: 'inherit',
  });

  let cleanedUp = false;
  const cleanUp = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (!KEEP) removeStore(dataDir);
  };

  child.on('error', (err) => {
    console.error(`Could not start the server: ${err.message}`);
    cleanUp();
    process.exit(1);
  });
  child.on('exit', (code) => {
    cleanUp();
    process.exit(code === null ? 0 : code);
  });

  // Ctrl+C reaches the child too; clean up once it is actually gone.
  process.on('SIGINT', () => { try { child.kill(); } catch (_) { cleanUp(); } });
  process.on('SIGTERM', () => { try { child.kill(); } catch (_) { cleanUp(); } });

  if (OPEN_BROWSER) setTimeout(() => openBrowser(`http://127.0.0.1:${PORT}`), 600);
}

if (require.main === module) main();

module.exports = { seed, PROJECTS, REQUESTS };
