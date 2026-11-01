/**
 * Composition test against the REAL shipped executor.
 *
 * The point of this file is the interaction, not either plugin alone: this
 * plugin prepends itself to the same `agent/request-error` waterfall the shipped
 * `@deepseek-ai/dsh-llm-retry` listens on. These tests drive both listeners with
 * one fake Cordis context and assert which one actually *scheduled* the retry,
 * so a connection outage can never run two retry chains — which would mean two
 * provider requests per second against an endpoint that is already failing.
 *
 * "Who decided" is read from the durable event, not from the waterfall return
 * value: a downstream decision propagates back up through `next()`, so the return
 * value alone cannot distinguish "decided here" from "passed along". This plugin
 * stamps every chain with a `netretry-` id; the shipped executor mints a UUID.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply as applyNetworkRetry } from '../lib/index.js';
import { loadShippedExecutor } from './shipped-executor.js';

/** Which plugin scheduled a `llm/retry` record. */
function originOf(event) {
  return String(event.data.retryId).startsWith('netretry-') ? 'network-retry' : 'shipped';
}

/**
 * A minimal projection registry that behaves like `ctx.sessionProjections`:
 * `stateOf` folds registered units over the events appended so far.
 */
function fakeProjections() {
  const units = new Map();
  return {
    register(definition) {
      units.set(definition.key, definition);
      return () => units.delete(definition.key);
    },
    stateOf(session, key) {
      const unit = units.get(key);
      if (unit === undefined) return {};
      let state = unit.init();
      for (const event of session.events) state = unit.apply(state, event);
      return state;
    },
  };
}

/**
 * Build one shared fake context where several plugins register on the same
 * waterfall, in registration order.
 */
function compositionContext() {
  const listeners = new Map();
  const effects = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sessionProjections: fakeProjections(),
    on(event, listener, options) {
      const entry = listeners.get(event) ?? [];
      // Mirrors Cordis: `prepend` unshifts, plain registration pushes.
      if (options?.prepend) entry.unshift(listener);
      else entry.push(listener);
      listeners.set(event, entry);
      return () => {
        const list = listeners.get(event) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(factory) {
      effects.push(factory);
      return () => {};
    },
    // This composition harness provides none of the crash-recovery services, so
    // a correct `ctx.inject` runs no callback at all — matching a profile without
    // session persistence. The real-service behavior is covered by
    // `crash-recovery-real.test.js` against actual Cordis.
    inject() {
      return () => {};
    },
  };
  return { ctx, listeners, effects };
}

/** A fake agent/session pair that records durable events, exactly like the real one. */
function fakeAgent(events) {
  return {
    id: 'session-under-test',
    session: {
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
}

/** A waterfall payload shaped exactly like the real `agent/request-error` one. */
function payload(agent, overrides = {}) {
  return {
    agent,
    turn: 1,
    step: 1,
    provider: 'tencent-intranet',
    failure: { code: 'TRANSPORT', message: 'connection reset by peer' },
    // What the tencent adapter registers today: a bounded normal policy.
    retryPolicy: {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Run the whole waterfall for one payload, outermost listener first. */
async function dispatch(listeners, request) {
  const handlers = listeners.get('agent/request-error') ?? [];
  const run = async (index) => {
    const handler = handlers[index];
    if (handler === undefined) return undefined;
    return handler(request, () => run(index + 1));
  };
  return run(0);
}

/** Compose both plugins on one context, or `null` when the harness is absent. */
async function compose() {
  const shipped = await loadShippedExecutor();
  if (shipped === null) return null;
  const { ctx, listeners } = compositionContext();
  applyNetworkRetry(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
  shipped.apply(ctx, {});
  // This plugin prepends itself, so it is handler 0 and the shipped one is 1.
  assert.equal((listeners.get('agent/request-error') ?? []).length, 2);
  return { listeners, shipped };
}

describe('composition with the shipped llm-retry executor', () => {
  it('lets only this plugin own a connection failure', async (t) => {
    const composed = await compose();
    if (composed === null) return t.skip('shipped llm-retry executor not installed');

    const events = [];
    const action = await dispatch(composed.listeners, payload(fakeAgent(events)));

    assert.deepEqual(action, { kind: 'retry' });
    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.equal(scheduled.length, 1, 'one chain, not two');
    assert.equal(originOf(scheduled[0]), 'network-retry');
    assert.equal(scheduled[0].data.mode, 'always');
  });

  it('keeps repeated connection failures on one unbounded chain', async (t) => {
    const composed = await compose();
    if (composed === null) return t.skip('shipped llm-retry executor not installed');

    const events = [];
    const agent = fakeAgent(events);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const action = await dispatch(composed.listeners, payload(agent));
      assert.deepEqual(action, { kind: 'retry' });
    }

    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.equal(scheduled.length, 4);
    assert.deepEqual(scheduled.map(originOf), Array(4).fill('network-retry'));
    assert.deepEqual(scheduled.map((event) => event.data.retry), [1, 2, 3, 4]);
    // One chain id, so the Chat UI groups them as one recovery attempt.
    assert.equal(new Set(scheduled.map((event) => event.data.retryId)).size, 1);
  });

  it('hands a bounded failure to the shipped executor without doubling', async (t) => {
    const composed = await compose();
    if (composed === null) return t.skip('shipped llm-retry executor not installed');

    // SERVER is bounded here and exhausted at once, so the shipped executor runs.
    const { ctx, listeners } = compositionContext();
    applyNetworkRetry(ctx, { maxRetries: 0, requestBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    composed.shipped.apply(ctx, {});

    const events = [];
    const action = await dispatch(
      listeners,
      payload(fakeAgent(events), { failure: { code: 'SERVER', message: '503' } }),
    );

    assert.deepEqual(action, { kind: 'retry' });
    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.equal(scheduled.length, 1, 'exactly one plugin scheduled it');
    assert.equal(originOf(scheduled[0]), 'shipped');
    assert.equal(scheduled[0].data.mode, 'normal');
  });

  it('never wakes the shipped executor for an aborted turn', async (t) => {
    const composed = await compose();
    if (composed === null) return t.skip('shipped llm-retry executor not installed');

    const controller = new AbortController();
    controller.abort(new Error('user pressed stop'));
    const events = [];
    const action = await dispatch(
      composed.listeners,
      payload(fakeAgent(events), { signal: controller.signal }),
    );

    assert.equal(action, undefined);
    assert.equal(events.length, 0, 'no plugin scheduled anything');
  });

  it('leaves an adapter that already retries forever entirely to the shipped executor', async (t) => {
    const composed = await compose();
    if (composed === null) return t.skip('shipped llm-retry executor not installed');

    const events = [];
    await dispatch(
      composed.listeners,
      payload(fakeAgent(events), {
        retryPolicy: { mode: 'always', initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
      }),
    );

    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.equal(scheduled.length, 1, 'the adapter-owned chain ran exactly once');
    assert.equal(originOf(scheduled[0]), 'shipped', 'not a second chain from this plugin');
  });
});

describe('durable event shape parity with the shipped executor', () => {
  /**
   * The Chat UI projects retry rows by reading named fields off these two events
   * (`dsh-client-ui-chat` → conversation-nodes/retry.js). If this plugin's shape
   * drifted — a renamed field, or `maxRetries` present in always mode — the row
   * would render with missing numbers instead of failing loudly. Pinning the key
   * set to the shipped executor's keeps the UI contract honest.
   */
  const EVENT_FIELDS = {
    'llm/retry': ['delayMs', 'failure', 'mode', 'policyKey', 'provider', 'retry', 'retryId', 'step', 'turn'],
    'llm/retry-started': ['retry', 'retryId', 'step', 'turn'],
  };

  /** Minimal context + capture harness for one waterfall call. */
  async function capture(applyPlugin, config, policy, failure) {
    const { ctx, listeners } = compositionContext();
    applyPlugin(ctx, config);
    const events = [];
    const agent = fakeAgent(events);
    const handler = (listeners.get('agent/request-error') ?? [])[0];
    await handler(payload(agent, { failure, retryPolicy: policy }), async () => undefined);
    return events;
  }

  it('writes the same fields as the shipped executor in bounded mode', async (t) => {
    const shipped = await loadShippedExecutor();
    if (shipped === null) return t.skip('shipped llm-retry executor not installed');

    const policy = {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['SERVER'],
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitterRatio: 0.1,
    };
    const failure = { code: 'SERVER', message: '503' };
    const mine = await capture(applyNetworkRetry, { requestBackoff: { initialDelayMs: 1, maxDelayMs: 2 } }, policy, failure);
    const theirs = await capture(shipped.apply, {}, policy, failure);

    for (const type of ['llm/retry', 'llm/retry-started']) {
      const a = Object.keys(mine.find((event) => event.type === type).data).sort();
      const b = Object.keys(theirs.find((event) => event.type === type).data).sort();
      assert.deepEqual(a, b, `${type} field parity`);
      assert.deepEqual(a, [...EVENT_FIELDS[type], ...(type === 'llm/retry' ? ['maxRetries'] : [])].sort(), `${type} expected shape`);
    }
  });

  it('omits maxRetries in always mode, exactly like the shipped executor', async (t) => {
    const shipped = await loadShippedExecutor();
    if (shipped === null) return t.skip('shipped llm-retry executor not installed');

    const mine = await capture(
      applyNetworkRetry,
      { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 } },
      { mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'], initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0.1 },
      { code: 'TRANSPORT', message: 'connection reset' },
    );
    const theirs = await capture(
      shipped.apply,
      {},
      { mode: 'always', initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0.1 },
      { code: 'TRANSPORT', message: 'connection reset' },
    );

    const mineKeys = Object.keys(mine.find((event) => event.type === 'llm/retry').data).sort();
    const theirKeys = Object.keys(theirs.find((event) => event.type === 'llm/retry').data).sort();
    assert.deepEqual(mineKeys, theirKeys, 'always-mode field parity');
    assert.equal(mineKeys.includes('maxRetries'), false, 'always mode carries no finite budget');
  });
});
