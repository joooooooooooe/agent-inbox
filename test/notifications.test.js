'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, createSound } = require('../public/notifications');
const question = (id, extra = {}) => ({ id, status: 'open', title: 'A question', ask: 'Which?', ...extra });
const event = (actor, message) => ({ actor, message, at: '2026-10-02T18:00:00Z' });
const snapshot = (requests = [], events = [], seen_event = -1) => ({
  requests, submissions: [{ id: 'sub-test', events, seen_event }],
});

test('initial backlog is silent; new questions batch once and never repeat', () => {
  const tracker = createTracker();
  assert.equal(tracker.update(snapshot([question('old')], [event('agent', 'Old reply')])), false);
  const next = snapshot([question('old'), question('new'), question('another')], [event('agent', 'Old reply')]);
  assert.equal(tracker.update(next), true);
  assert.equal(tracker.update(next), false);
  assert.equal(tracker.update(snapshot([])), false);
  assert.equal(tracker.update(next), false); // temporary disappearance is not a new arrival
});

test('each new agent reply alerts even while previous replies remain unread', () => {
  const tracker = createTracker();
  const replies = [event('agent', 'First')];
  tracker.update(snapshot([], replies));
  replies.push(event('operator', 'My reply'));
  assert.equal(tracker.update(snapshot([], replies)), false);
  replies.push(event('agent', 'Second'));
  assert.equal(tracker.update(snapshot([], replies)), true);
  assert.equal(tracker.update(snapshot([], replies, 2)), false);
  replies.push(event('agent', 'Third'));
  assert.equal(tracker.update(snapshot([], replies, 2)), true);
  assert.equal(tracker.update(snapshot([], replies, 2)), false);
});

test('new submissions are silent unless they contain a new unread agent reply', () => {
  const tracker = createTracker();
  tracker.update({});
  assert.equal(tracker.update(snapshot([], [event('operator', 'Hello')])), false);
  assert.equal(tracker.update({ submissions: [{ id: 'sub-other', events: [event('agent', 'Already read')], seen_event: 0 }] }), false);
  assert.equal(tracker.update({ submissions: [{ id: 'sub-new', events: [event('agent', 'Incoming')], seen_event: -1 }] }), true);
});

test('answering and returning questions are quiet; rewritten and reopened questions alert', () => {
  const tracker = createTracker();
  tracker.update(snapshot([question('q')]));
  assert.equal(tracker.update(snapshot([question('q', { clarity_warnings: ['lint'] })])), false);
  assert.equal(tracker.update(snapshot([question('q', { status: 'answered' })])), false);
  assert.equal(tracker.update(snapshot([question('q')])), true);
  assert.equal(tracker.update(snapshot([question('q', { status: 'returned' })])), false);
  assert.equal(tracker.update(snapshot([question('q', { ask: 'Rewritten question?' })])), true);
  assert.equal(tracker.update(snapshot([question('q', { archived: true })])), false);
});

function audioEnv({ stored = null, brokenStorage = false, rejectResume = false } = {}) {
  const scheduled = [];
  const storage = {
    getItem() { if (brokenStorage) throw Error('Blocked'); return stored; },
    setItem(key, value) { if (brokenStorage) throw Error('Blocked'); stored = value; },
  };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { if (rejectResume) throw Error('Blocked'); this.state = 'running'; }
    createOscillator() {
      return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {},
        start(at) { scheduled.push(at); }, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() {} };
    }
  }
  return { env: { localStorage: storage, AudioContext }, scheduled, stored: () => stored };
}

test('audio needs activation; mute persists, preview works when muted, and re-enable works', async () => {
  const fixture = audioEnv();
  const sound = createSound(fixture.env);
  assert.equal(sound.play(), false);
  assert.equal(await sound.unlock(), true);
  assert.equal(sound.play(), true);
  assert.equal(fixture.scheduled.length, 2);
  sound.setEnabled(false);
  assert.equal(fixture.stored(), 'off');
  assert.equal(sound.play(), false);
  assert.equal(sound.play(true), true);
  assert.equal(createSound(fixture.env).enabled, false);
  sound.setEnabled(true);
  assert.equal(fixture.stored(), 'on');
  assert.equal(sound.play(), true);
});

test('unavailable audio, blocked storage and rejected audio activation fail gracefully', async () => {
  const unsupported = createSound({});
  assert.equal(unsupported.supported, false);
  assert.equal(await unsupported.unlock(), false);
  assert.equal(unsupported.play(), false);
  const privateSound = createSound(audioEnv({ brokenStorage: true }).env);
  privateSound.setEnabled(false);
  assert.equal(await privateSound.unlock(), true);
  const blocked = createSound(audioEnv({ rejectResume: true }).env);
  assert.equal(await blocked.unlock(), false);
  assert.equal(blocked.play(), false);
});
