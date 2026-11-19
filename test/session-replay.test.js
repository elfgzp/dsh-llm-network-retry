/**
 * Replay every retry event the plugin writes through the harness's own v4
 * session reader.
 *
 * Why this file exists: the retry events are not merely UI hints, they are
 * durable session log rows that DeepSeek Harness validates on load. The v4
 * reader identifies a retry chain by `(turn, step, provider, policyKey)` and
 * insists each chain counts from 1 with one `retryId`, and a violated rule makes
 * the whole conversation unreadable ("history failed to load"). A unit test on
 * the plugin's own bookkeeping cannot catch that class of bug — only the real
 * reader can — so these tests build a session log out of the plugin's real
 * output and feed it to the shipped restore path.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply } from '../lib/index.js';
import { loadSessionPackages } from './dsh-session.js';

const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-replay-under-test',
  createdAt: 1_700_000_000_000,
  cwd: '/tmp',
  isSeeded: false,
  delegationDepth: 0,
};

/** A fake context: only the waterfall and the disposal effect matter here. */
function fakeContext() {
  const listeners = new Map();
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      const entry = listeners.get(event) ?? [];
      if (options?.prepend) entry.unshift(listener);
      else entry.push(listener);
      listeners.set(event, entry);
      return () => {};
    },
    effect() {
      return () => {};
    },
    inject() {
      return () => {};
    },
  };
  return { ctx, listeners };
}

/**
 * A fake agent that records every appended event as a full session row, so the
 * replay sees exactly what the real session would have stored.
 */
function fakeAgent() {
  const events = [];
  return {
    events,
    agent: {
      id: HEADER.id,
      session: {
        append(type, data) {
          events.push({ type, seq: events.length, time: 1_700_000_000_000 + events.length, data });
        },
        requestHeader() {
          return { config: { provider: 'p', model: 'm' } };
        },
      },
    },
  };
}

/** Fire the waterfall once, the way the agent loop does. */
async function fire(listeners, payload) {
  const handlers = listeners.get('agent/request-error') ?? [];
  const run = async (index) => {
    const handler = handlers[index];
    if (handler === undefined) return undefined;
    return handler(payload, () => run(index + 1));
  };
  return run(0);
}

/** A waterfall payload shaped like the real one. */
function payload(agent, failure, signal = new AbortController().signal) {
  return {
    agent,
    turn: 1,
    step: 1,
    provider: 'open-design',
    failure,
    // The provider policy a real adapter registers: bounded normal mode, so this
    // plugin keeps ownership of the connection failures it takes over.
    retryPolicy: {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['SERVER', 'TRANSPORT', 'TIMEOUT', 'NETWORK'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    },
    signal,
  };
}

/**
 * Build one complete, structurally valid session log around the events under
 * test and ask the installed reader to restore it.
 *
 * The surrounding rows are the minimum a v4 log needs to be well formed: a
 * `turn/start`, one `request/header`, and a `turn/end` after the last step.
 *
 * @returns the restored artifact.
 */
function replay(sessionPackages, events) {
  const { catalog } = sessionPackages;
  const restore = catalog.sessionFormatCatalog.createRestore(HEADER, {
    recovery: 'strict',
    validation: 'current',
  });
  const rows = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'request/header',
      seq: 1,
      time: 1,
      data: {
        header: { config: { provider: 'open-design', model: 'm' } },
        reason: 'initial',
      },
    },
    { type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 1 } },
  ];
  for (const event of events) rows.push({ ...event, seq: rows.length });
  rows.push({ type: 'step/end', seq: rows.length, time: 1, data: { turn: 1, step: 1 } });
  rows.push({ type: 'turn/end', seq: rows.length, time: 1, data: { turn: 1, reason: { kind: 'completed' } } });
  for (const row of rows) restore.decodeRow(row);
  return restore.finish();
}

const CONNECTION = { code: 'TRANSPORT', message: 'socket closed' };
const SERVER = { code: 'SERVER', message: '524 origin timeout' };

describe('replay through the real v4 session reader', () => {
  it('accepts a step whose failure category flips normal -> always', async (t) => {
    const sessionPackages = await loadSessionPackages();
    if (sessionPackages === null) return t.skip('DeepSeek Harness session packages not installed');

    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 }, requestBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const { agent, events } = fakeAgent();

    // The exact shape that bricked a conversation: two bounded retries, then the
    // socket drops and the unbounded chain takes over inside the same step.
    await fire(listeners, payload(agent, SERVER));
    await fire(listeners, payload(agent, SERVER));
    await fire(listeners, payload(agent, CONNECTION));
    await fire(listeners, payload(agent, CONNECTION));

    const retries = events.filter((event) => event.type === 'llm/retry' || event.type === 'llm/retry-started');
    assert.equal(retries.length, 8, 'four attempts, each with a scheduled row and a started row');

    // The reader is the judge: it throws "llm/retry skips its policy attempt
    // sequence" for the pre-fix numbering, which is the entire reported bug.
    const artifact = replay(sessionPackages, events);
    assert.equal(artifact.events.at(-1).type, 'turn/end');

    // The two chains are independent in the log's own terms.
    const scheduled = retries.filter((event) => event.type === 'llm/retry');
    const bounded = scheduled.filter((event) => event.data.mode === 'normal');
    const unbounded = scheduled.filter((event) => event.data.mode === 'always');
    assert.deepEqual(bounded.map((event) => event.data.retry), [1, 2]);
    assert.deepEqual(unbounded.map((event) => event.data.retry), [1, 2]);
    assert.notEqual(bounded[0].data.policyKey, unbounded[0].data.policyKey);
    assert.notEqual(bounded[0].data.retryId, unbounded[0].data.retryId);
  });

  it('accepts a step that flips back to the bounded chain it already used', async (t) => {
    const sessionPackages = await loadSessionPackages();
    if (sessionPackages === null) return t.skip('DeepSeek Harness session packages not installed');

    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 }, requestBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const { agent, events } = fakeAgent();

    // bounded, unbounded, bounded again: the third failure resumes the first
    // chain's numbering instead of restarting or skipping it.
    await fire(listeners, payload(agent, SERVER));
    await fire(listeners, payload(agent, CONNECTION));
    await fire(listeners, payload(agent, SERVER));

    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.deepEqual(scheduled.map((event) => [event.data.mode, event.data.retry]), [
      ['normal', 1],
      ['always', 1],
      ['normal', 2],
    ]);
    assert.equal(scheduled[0].data.retryId, scheduled[2].data.retryId, 'the bounded chain keeps its id');

    const artifact = replay(sessionPackages, events);
    assert.equal(artifact.events.at(-1).type, 'turn/end');
  });

  it('accepts many unbounded attempts with an occasional bounded one interleaved', async (t) => {
    const sessionPackages = await loadSessionPackages();
    if (sessionPackages === null) return t.skip('DeepSeek Harness session packages not installed');

    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 }, requestBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const { agent, events } = fakeAgent();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await fire(listeners, payload(agent, CONNECTION));
      await fire(listeners, payload(agent, SERVER));
    }

    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.deepEqual(
      scheduled.filter((event) => event.data.mode === 'always').map((event) => event.data.retry),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      scheduled.filter((event) => event.data.mode === 'normal').map((event) => event.data.retry),
      [1, 2, 3, 4, 5],
      'the bounded chain stops at maxRetries and delegates the sixth',
    );

    const artifact = replay(sessionPackages, events);
    assert.equal(artifact.events.at(-1).type, 'turn/end');
  });

  it('still writes a readable log when the retry is cancelled mid-wait', async (t) => {
    const sessionPackages = await loadSessionPackages();
    if (sessionPackages === null) return t.skip('DeepSeek Harness session packages not installed');

    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const { agent, events } = fakeAgent();

    const controller = new AbortController();
    await fire(listeners, payload(agent, CONNECTION));
    controller.abort();
    await fire(listeners, payload(agent, CONNECTION, controller.signal));

    const artifact = replay(sessionPackages, events);
    assert.equal(artifact.events.at(-1).type, 'turn/end');
  });
});
