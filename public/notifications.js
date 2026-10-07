'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InboxNotifications = api;
}(typeof self !== 'undefined' ? self : this, function () {
  function createTracker() {
    let initialized = false;
    const questions = new Map();
    const events = new Set();
    return {
      update(state) {
        let incoming = false;
        for (const r of state.requests || []) {
          const fingerprint = JSON.stringify([
            r.status, r.title, r.ask, r.background, r.options, r.recommended, r.blocking,
          ]);
          if (r.status === 'open' && !r.archived && questions.get(r.id) !== fingerprint) incoming = true;
          questions.set(r.id, fingerprint);
        }
        for (const s of state.submissions || []) {
          (s.events || []).forEach((event, index) => {
            const key = JSON.stringify([s.id, index, event.at, event.actor, event.message]);
            if (event.actor === 'agent' && index > (s.seen_event ?? -1) && !events.has(key)) incoming = true;
            events.add(key);
          });
        }
        // The first successful snapshot is the baseline, never a backlog alarm.
        const notify = initialized && incoming;
        initialized = true;
        return notify;
      },
    };
  }

  function createSound(env, onChange = () => {}) {
    const storageKey = 'agent-inbox-sound';
    let enabled = true;
    let context = null;
    try { enabled = env.localStorage.getItem(storageKey) !== 'off'; } catch (_) { /* private browsing */ }
    const supported = !!(env.AudioContext || env.webkitAudioContext);
    function ready() { return context?.state === 'running'; }
    function setEnabled(value) {
      enabled = !!value;
      try { env.localStorage.setItem(storageKey, enabled ? 'on' : 'off'); } catch (_) { /* optional persistence */ }
      onChange();
    }
    async function unlock() {
      if (!supported) return false;
      try {
        if (!context) {
          context = new (env.AudioContext || env.webkitAudioContext)();
          context.onstatechange = onChange;
        }
        if (!ready()) await context.resume();
        onChange();
        return ready();
      } catch (_) { onChange(); return false; }
    }
    function play(preview = false) {
      if ((!enabled && !preview) || !ready()) return false;
      try {
        // A short, original two-note bell; no downloaded audio or external requests.
        const start = context.currentTime + 0.01;
        [660, 880].forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const at = start + index * 0.15;
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency, at);
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(0.14, at + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(at);
          oscillator.stop(at + 0.65);
        });
        return true;
      } catch (_) { return false; }
    }
    return { supported, get enabled() { return enabled; }, ready, setEnabled, unlock, play };
  }
  return { createTracker, createSound };
}));
