/**
 * The boot scan.
 *
 * The property under test is not "does it find crashes" — it is "does it find
 * them without taking ownership". A scan that resumed sessions would collide with
 * the user's own click on that session, so the read-only guarantee is asserted
 * directly against the persistence calls the scanner makes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanInterrupted, toBadgeIndex } from '../lib/scan.js';

/** One committed event. */
function event(type, data = {}, seq = 0) {
  return { type, seq, time: 0, data };
}

/** A log that ends interrupted, with one open tool call. */
function interruptedLog(turn = 7) {
  return [
    event('turn/start', { turn }, 0),
    event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }, 1),
    event('turn/end', { turn, reason: { kind: 'interrupted' } }, 2),
  ];
}

/** A log that finished normally. */
function cleanLog() {
  return [event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 0)];
}

/**
 * A persistence double that records every call it receives.
 * @param logs - session id to event list.
 */
function fakePersistence(logs, { failList = false } = {}) {
  const calls = [];
  return {
    calls,
    async list(options) {
      calls.push({ op: 'list', options });
      if (failList) throw new Error('backend unavailable');
      return Object.keys(logs).map((id) => ({ id, revision: 'r1' }));
    },
    async open(id, access, options) {
      calls.push({ op: 'open', id, access, options });
      if (logs[id] === undefined) throw new Error('not found');
      return {
        async read(from, to, opts) {
          calls.push({ op: 'read', id, opts });
          return { events: logs[id] };
        },
        async close() {
          calls.push({ op: 'close', id });
        },
      };
    },
  };
}

describe('scanInterrupted', () => {
  it('finds only the sessions that ended interrupted', async () => {
    const persistence = fakePersistence({
      clean: cleanLog(),
      crashed: interruptedLog(9),
    });
    const found = await scanInterrupted(persistence);
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, 'crashed');
    assert.equal(found[0].turn, 9);
    assert.deepEqual(found[0].unfinishedNames, ['bash']);
  });

  it('never takes write ownership, so the user can still open the session', async () => {
    const persistence = fakePersistence({ crashed: interruptedLog() });
    await scanInterrupted(persistence);
    const opens = persistence.calls.filter((call) => call.op === 'open');
    assert.ok(opens.length > 0);
    for (const open of opens) {
      assert.equal(open.access, 'read', 'a scan must not claim the session writer');
    }
  });

  it('closes every handle it opens', async () => {
    const persistence = fakePersistence({ a: interruptedLog(), b: cleanLog(), c: interruptedLog() });
    await scanInterrupted(persistence);
    const opened = persistence.calls.filter((call) => call.op === 'open').map((c) => c.id);
    const closed = persistence.calls.filter((call) => call.op === 'close').map((c) => c.id);
    assert.deepEqual(closed.sort(), opened.sort(), 'leaking a read handle would keep the log open forever');
  });

  it('returns nothing when persistence is absent', async () => {
    assert.deepEqual(await scanInterrupted(undefined), []);
  });

  it('returns nothing rather than throwing when the backend cannot list', async () => {
    const persistence = fakePersistence({}, { failList: true });
    assert.deepEqual(await scanInterrupted(persistence), []);
  });

  it('skips a session that disappears between list and open', async () => {
    const persistence = fakePersistence({ crashed: interruptedLog() });
    // list() still reports a session that open() no longer has.
    const originalList = persistence.list;
    persistence.list = async (options) => {
      await originalList(options);
      return [{ id: 'crashed' }, { id: 'deleted' }];
    };
    const found = await scanInterrupted(persistence);
    assert.deepEqual(found.map((f) => f.sessionId), ['crashed']);
  });

  it('stops early when cancelled', async () => {
    const controller = new AbortController();
    const logs = {};
    for (let i = 0; i < 20; i += 1) logs[`s${i}`] = interruptedLog();
    const persistence = fakePersistence(logs);
    const originalRead = persistence.open;
    let reads = 0;
    persistence.open = async (...args) => {
      reads += 1;
      if (reads === 3) controller.abort(new Error('cancelled'));
      return originalRead(...args);
    };
    await scanInterrupted(persistence, { signal: controller.signal });
    assert.ok(reads < 20, 'a cancelled scan must stop instead of walking the whole history');
  });
});

describe('toBadgeIndex', () => {
  it('keys by session id so a row renders in constant time', () => {
    const index = toBadgeIndex([
      { sessionId: 'a', turn: 3, unfinishedNames: ['bash', 'read'] },
      { sessionId: 'b', turn: 8, unfinishedNames: [] },
    ]);
    assert.deepEqual(index, {
      a: { turn: 3, unfinished: ['bash', 'read'] },
      b: { turn: 8, unfinished: [] },
    });
  });

  it('tolerates an absent scan', () => {
    assert.deepEqual(toBadgeIndex(undefined), {});
    assert.deepEqual(toBadgeIndex([]), {});
  });
});
