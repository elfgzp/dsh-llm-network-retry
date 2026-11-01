/**
 * Behavioural test for the Host half against a fake Cordis context.
 *
 * The real `agent/request-error` waterfall and `agent.session.append` are
 * mocked at the contract level (fire the listener with a payload, observe the
 * durable events and the returned action) so the test proves what the running
 * plugin does rather than what a helper returns.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply } from '../lib/index.js';

/** Build a fake HOST context that captures registrations and lets tests fire events. */
function fakeContext(config = {}) {
  const listeners = new Map();
  const effects = [];
  const logs = [];
  const ctx = {
    logger: {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    on(event, listener) {
      const entry = listeners.get(event) ?? [];
      entry.push(listener);
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
  };
  return { ctx, listeners, effects, logs };
}

/** Build a fake agent whose session records every appended event. */
function fakeAgent(events, options = {}) {
  return {
    id: 'session-1',
    session: {
      append(type, data) {
        if (options.failAppend === type) throw new Error('append rejected');
        events.push({ type, data });
        return { type, data };
      },
      requestHeader() {
        return options.header ?? { config: { provider: 'tencent-intranet', model: 'deepseek-v4.1-flash-ioa' } };
      },
    },
  };
}

/** Fire every registered `agent/request-error` listener as a waterfall. */
async function fireError(listeners, payload, next = async () => undefined) {
  const handlers = listeners.get('agent/request-error') ?? [];
  assert.ok(handlers.length > 0, 'the plugin registered a request-error listener');
  // `prepend: true` puts the plugin first; the fake context preserves order.
  const dispatch = async (index) => {
    const handler = handlers[index];
    if (handler === undefined) return next();
    return handler(payload, () => dispatch(index + 1));
  };
  return dispatch(0);
}

/** A payload shaped exactly like the real waterfall's. */
function payload(overrides = {}) {
  return {
    agent: undefined,
    turn: 1,
    step: 1,
    provider: 'tencent-intranet',
    failure: { code: 'TRANSPORT', message: 'socket closed' },
    retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('apply — registration', () => {
  it('registers one request-error listener and a disposal effect', () => {
    const { ctx, listeners, effects } = fakeContext();
    apply(ctx, {});
    assert.equal(listeners.get('agent/request-error')?.length, 1);
    assert.equal(effects.length, 1);
  });

  it('rejects a config typo at activation instead of ignoring it', () => {
    const { ctx } = fakeContext();
    assert.throws(() => apply(ctx, { maxRetires: 2 }), /unknown option/);
  });
});

describe('apply — retrying a connection failure', () => {
  it('records the scheduled attempt before waiting, then the started marker', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });

    const agent = fakeAgent(events);
    const action = await fireError(listeners, payload({ agent }));

    assert.deepEqual(action, { kind: 'retry' });
    assert.equal(events[0].type, 'llm/retry');
    assert.equal(events[0].data.mode, 'always');
    assert.equal(events[0].data.retry, 1);
    assert.equal(events[0].data.provider, 'tencent-intranet');
    assert.equal(events[0].data.failure.code, 'TRANSPORT');
    assert.equal(events[0].data.turn, 1);
    assert.equal(events[0].data.step, 1);
    assert.equal(typeof events[0].data.retryId, 'string');
    assert.equal(typeof events[0].data.policyKey, 'string');
    // always mode carries no maxRetries, exactly like the shipped executor.
    assert.equal('maxRetries' in events[0].data, false);

    assert.equal(events[1].type, 'llm/retry-started');
    assert.equal(events[1].data.retry, 1);
    assert.equal(events[1].data.retryId, events[0].data.retryId);
  });

  it('keeps one retry chain and increments the attempt across repeated failures', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const agent = fakeAgent(events);

    await fireError(listeners, payload({ agent }));
    await fireError(listeners, payload({ agent }));
    await fireError(listeners, payload({ agent }));

    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.deepEqual(scheduled.map((event) => event.data.retry), [1, 2, 3]);
    // One chain id for the whole step, so the UI groups the attempts.
    assert.equal(new Set(scheduled.map((event) => event.data.retryId)).size, 1);
  });

  it('starts a fresh chain on the next step', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const agent = fakeAgent(events);

    await fireError(listeners, payload({ agent, step: 1 }));
    await fireError(listeners, payload({ agent, step: 1 }));
    await fireError(listeners, payload({ agent, step: 2 }));

    const scheduled = events.filter((event) => event.type === 'llm/retry');
    assert.deepEqual(scheduled.map((event) => event.data.retry), [1, 2, 1]);
    assert.equal(new Set(scheduled.map((event) => event.data.retryId)).size, 2);
  });
});

describe('apply — bounded failures', () => {
  it('retries a server error a bounded number of times, then delegates', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, { maxRetries: 2, requestBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const agent = fakeAgent(events);
    let delegated = 0;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const action = await fireError(listeners, payload({ agent, failure: { code: 'SERVER', message: '503' } }));
      assert.deepEqual(action, { kind: 'retry' });
    }

    const final = await fireError(
      listeners,
      payload({ agent, failure: { code: 'SERVER', message: '503' } }),
      async () => {
        delegated += 1;
        return undefined;
      },
    );
    assert.equal(final, undefined);
    assert.equal(delegated, 1);
    assert.equal(events.filter((event) => event.type === 'llm/retry').length, 2);
  });

  it('delegates a fatal code without waiting', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, {});
    const agent = fakeAgent(events);

    let delegated = 0;
    const action = await fireError(
      listeners,
      payload({ agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } }),
      async () => {
        delegated += 1;
        return undefined;
      },
    );
    assert.equal(action, undefined);
    assert.equal(delegated, 1);
    assert.equal(events.length, 0);
  });

  it('delegates an auth failure', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, {});
    let delegated = 0;
    await fireError(
      listeners,
      payload({ agent: fakeAgent(events), failure: { code: 'AUTH', message: '401' } }),
      async () => {
        delegated += 1;
      },
    );
    assert.equal(delegated, 1);
    assert.equal(events.length, 0);
  });

  it('delegates when the adapter already runs unlimited recovery', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, {});
    let delegated = 0;
    await fireError(
      listeners,
      payload({
        agent: fakeAgent(events),
        retryPolicy: { mode: 'always', initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
      }),
      async () => {
        delegated += 1;
      },
    );
    assert.equal(delegated, 1);
    assert.equal(events.length, 0);
  });
});

describe('apply — cancellation and failure paths', () => {
  it('stops waiting when the turn is aborted and delegates nothing', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 60_000, maxDelayMs: 60_000 } });
    const agent = fakeAgent(events);
    const controller = new AbortController();

    const pending = fireError(listeners, payload({ agent, signal: controller.signal }));
    // The durable record must land before the wait, so cancelling still leaves history.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'llm/retry');

    controller.abort(new Error('user cancelled'));
    const action = await pending;
    assert.equal(action, undefined);
    assert.equal(events.filter((event) => event.type === 'llm/retry-started').length, 0);
  });

  it('delegates when the session log rejects the scheduled record', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 1, maxDelayMs: 2 } });
    const agent = fakeAgent(events, { failAppend: 'llm/retry' });

    let delegated = 0;
    const action = await fireError(listeners, payload({ agent }), async () => {
      delegated += 1;
      return undefined;
    });
    assert.equal(action, undefined);
    assert.equal(delegated, 1);
    assert.equal(events.length, 0);
  });

  it('does nothing when the request was already aborted on arrival', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, {});
    const controller = new AbortController();
    controller.abort(new Error('already gone'));

    // The loop re-checks the signal right after the waterfall, so an aborted turn
    // must not hand a downstream executor the chance to schedule a retry.
    let delegated = 0;
    const action = await fireError(
      listeners,
      payload({ agent: fakeAgent(events), signal: controller.signal }),
      async () => {
        delegated += 1;
      },
    );
    assert.equal(action, undefined);
    assert.equal(delegated, 0);
    assert.equal(events.length, 0);
  });

  it('refuses new retries after disposal and drains in-flight waits', async () => {
    const events = [];
    const { ctx, listeners, effects } = fakeContext();
    apply(ctx, { connectionBackoff: { initialDelayMs: 60_000, maxDelayMs: 60_000 } });
    const agent = fakeAgent(events);

    // Capture the listener before disposal: a real waterfall may already hold it.
    const staleListener = listeners.get('agent/request-error')[0];
    assert.ok(staleListener, 'the plugin registered a request-error listener');

    const pending = fireError(listeners, payload({ agent }));
    await new Promise((resolve) => setImmediate(resolve));

    const dispose = effects[0]()();
    const action = await pending;
    await dispose;
    assert.equal(action, undefined);

    // The stale callback must fail closed rather than schedule more work.
    let delegated = 0;
    const afterDispose = await staleListener(payload({ agent }), async () => {
      delegated += 1;
    });
    assert.equal(afterDispose, undefined);
    assert.equal(delegated, 0);
    assert.equal(events.filter((event) => event.type === 'llm/retry').length, 1);
  });
});

describe('apply — provider scope', () => {
  it('delegates providers outside the configured scope', async () => {
    const events = [];
    const { ctx, listeners } = fakeContext();
    apply(ctx, { providers: ['some-other-provider'] });
    let delegated = 0;
    await fireError(listeners, payload({ agent: fakeAgent(events) }), async () => {
      delegated += 1;
    });
    assert.equal(delegated, 1);
    assert.equal(events.length, 0);
  });
});
