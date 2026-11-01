import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { continuationMessage, continueInterrupted, inspectSession } from '../lib/host.js';

/** Build one committed event. */
function event(type, data = {}, seq = 0) {
  return { type, seq, time: 0, data };
}

/** A log whose trailing turn was interrupted with one tool left open. */
function interruptedLog() {
  return [
    event('turn/start', { turn: 1 }, 0),
    event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }, 1),
    event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 2),
  ];
}

/** A persistence double that serves one fixed log. */
function fakePersistence(events, { failOpen = false } = {}) {
  const calls = [];
  return {
    calls,
    async open(sessionId, mode, options) {
      calls.push({ sessionId, mode, options });
      if (failOpen) throw new Error('session is held by another writer');
      return {
        async read(from, to, opts) {
          calls.push({ read: true, from, to, opts });
          return { events };
        },
        async close() {},
      };
    },
  };
}

describe('continuationMessage', () => {
  const recovery = { turn: 4, unfinished: [{ name: 'bash' }] };

  it('is an identified user message, which is what the session log validates', () => {
    const message = continuationMessage(recovery);
    assert.equal(message.role, 'user');
    assert.equal(typeof message.id, 'string');
    assert.ok(message.id.length > 0, 'the log refuses a message without an id');
    assert.ok(Array.isArray(message.content));
    assert.equal(message.content[0].type, 'text');
    assert.equal(typeof message.source.kind, 'string');
    assert.ok(message.source.kind.length > 0, 'the log refuses an empty source kind');
  });

  it('tags the source so a later reader knows a plugin wrote it', () => {
    const message = continuationMessage(recovery);
    assert.equal(message.source.kind, 'llm-network-retry');
    assert.match(message.content[0].text, /不是你本人新写的指令/);
  });

  it('is frozen so nothing downstream can mutate the durable copy', () => {
    const message = continuationMessage(recovery);
    assert.ok(Object.isFrozen(message));
    assert.ok(Object.isFrozen(message.content));
    assert.ok(Object.isFrozen(message.source));
  });

  it('mints a fresh id per call, so two continuations are two distinct messages', () => {
    assert.notEqual(continuationMessage(recovery).id, continuationMessage(recovery).id);
  });
});

describe('inspectSession', () => {
  it('reads the log in read mode, never write mode', async () => {
    const persistence = fakePersistence(interruptedLog());
    await inspectSession(persistence, 's1', undefined);
    assert.equal(persistence.calls[0].mode, 'read', 'a crash-recovery read must not take write ownership');
  });

  it('reports the interrupt and the unfinished tools', async () => {
    const recovery = await inspectSession(fakePersistence(interruptedLog()), 's1');
    assert.equal(recovery.turn, 1);
    assert.deepEqual(recovery.unfinishedNames, ['bash']);
  });

  it('reports nothing for a session that finished cleanly', async () => {
    const events = [event('turn/end', { turn: 1, reason: { kind: 'completed' } })];
    assert.equal(await inspectSession(fakePersistence(events), 's1'), undefined);
  });

  it('reports nothing rather than throwing when the session cannot be opened', async () => {
    assert.equal(await inspectSession(fakePersistence([], { failOpen: true }), 's1'), undefined);
  });

  it('reports nothing when persistence is absent from the profile', async () => {
    assert.equal(await inspectSession(undefined, 's1'), undefined);
  });

  it('always closes the handle', async () => {
    let closed = 0;
    const persistence = {
      async open() {
        return {
          async read() {
            return { events: interruptedLog() };
          },
          async close() {
            closed += 1;
          },
        };
      },
    };
    await inspectSession(persistence, 's1');
    assert.equal(closed, 1);
  });

  it('closes the handle even when the read throws', async () => {
    let closed = 0;
    const persistence = {
      async open() {
        return {
          async read() {
            throw new Error('log shrank');
          },
          async close() {
            closed += 1;
          },
        };
      },
    };
    assert.equal(await inspectSession(persistence, 's1'), undefined);
    assert.equal(closed, 1);
  });
});

describe('continueInterrupted', () => {
  it('wakes the agent with one followup message', async () => {
    const appended = [];
    const agent = {
      id: 's1',
      followup: (message) => appended.push(message),
    };
    const result = await continueInterrupted({ agent, persistence: fakePersistence(interruptedLog()) });
    assert.equal(result.ok, true);
    assert.equal(result.turn, 1);
    assert.deepEqual(result.unfinished, ['bash']);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].role, 'user');
  });

  it('refuses when the log no longer has anything to recover', async () => {
    const appended = [];
    const agent = { id: 's1', followup: (m) => appended.push(m) };
    const clean = [event('turn/end', { turn: 1, reason: { kind: 'completed' } })];
    const result = await continueInterrupted({ agent, persistence: fakePersistence(clean) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'nothing-to-recover');
    assert.equal(appended.length, 0, 'a stale banner must not inject a turn');
  });

  it('is idempotent against a double click', async () => {
    const appended = [];
    const agent = { id: 's1', followup: (m) => appended.push(m) };
    // The first call recovers; simulate the log being closed by the new turn.
    let events = interruptedLog();
    const persistence = {
      async open() {
        const snapshot = events;
        return {
          async read() {
            return { events: snapshot };
          },
          async close() {},
        };
      },
    };
    const first = await continueInterrupted({ agent, persistence });
    assert.equal(first.ok, true);

    events = [...interruptedLog(), event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 99)];
    const second = await continueInterrupted({ agent, persistence });
    assert.equal(second.ok, false);
    assert.equal(appended.length, 1, 'exactly one turn was opened');
  });

  it('refuses an agent that cannot be woken', async () => {
    const result = await continueInterrupted({ agent: { id: 's1' }, persistence: fakePersistence(interruptedLog()) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'agent-unavailable');
  });
});
