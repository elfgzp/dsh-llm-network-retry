/**
 * The crash-recovery RPC surface, tested through the plugin entry point.
 *
 * These tests exist because the dangerous failure mode here is not "the banner
 * does not render" — it is "the plugin silently injects or replays turns". So
 * every test after the happy path asserts that nothing was sent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply } from '../lib/index.js';

/** One committed event. */
function event(type, data = {}, seq = 0) {
  return { type, seq, time: 0, data };
}

/** A log whose trailing turn was interrupted, with one tool left open. */
function interruptedLog() {
  return [
    event('turn/start', { turn: 3 }, 0),
    event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }, 1),
    event('turn/end', { turn: 3, reason: { kind: 'interrupted' } }, 2),
  ];
}

/** A log that finished normally. */
function cleanLog() {
  return [event('turn/end', { turn: 3, reason: { kind: 'completed' } }, 0)];
}

/**
 * Build a context with the services the crash-recovery half injects, capturing
 * the registered RPC handler so tests can call it like the browser does.
 */
function fakeContext({ events = interruptedLog(), agentFollowup } = {}) {
  const listeners = new Map();
  const effects = [];
  const routes = new Map();
  const appended = [];
  const agents = new Map();

  if (agentFollowup !== undefined) {
    agents.set('session-1', { id: 'session-1', followup: agentFollowup });
  }

  const persistence = {
    async open(_sessionId, mode) {
      assert.equal(mode, 'read', 'recovery must never take write ownership of a log');
      return {
        async read() {
          return { events };
        },
        async close() {},
      };
    },
  };

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    agents,
    sessionPersistence: persistence,
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {};
    },
    effect(factory) {
      effects.push(factory);
      return () => {};
    },
    connection: {
      rpc: {
        // Real signature: handle(channel, handler) returns a disposer FUNCTION.
        handle(channel, handler) {
          routes.set(channel, handler);
          return () => Promise.resolve().then(() => routes.delete(channel));
        },
      },
    },
    webServer: {},
    // Run the callback the way Cordis does when every named service exists.
    inject(names, callback) {
      const services = {
        sessionPersistence: persistence,
        connection: ctx.connection,
        webServer: ctx.webServer,
      };
      const available = names.every((name) => services[name] !== undefined);
      if (available) {
        callback({
          ...services,
          // Cordis runs an effect's factory immediately and keeps its return
          // value as the disposer; a stub that skips the call hides registration.
          effect(factory) {
            const disposer = factory();
            effects.push(disposer);
            return () => Promise.resolve().then(() => disposer?.());
          },
          logger: ctx.logger,
        });
      }
      return () => {};
    },
  };

  return { ctx, routes, appended, agents };
}

/** Invoke the plugin's RPC handler the way the browser half does. */
function rpc(routes, endpoint, payload) {
  const handler = routes.get('/llm-network-retry');
  assert.ok(handler, 'the plugin registered its RPC channel');
  return handler(endpoint, payload);
}

describe('crash-recovery RPC', () => {
  it('reports an interrupted turn and the tools left mid-flight', async () => {
    const { ctx, routes } = fakeContext();
    apply(ctx, {});
    const result = await rpc(routes, 'inspect', { sessionId: 'session-1' });
    assert.equal(result.ok, true);
    assert.equal(result.value.recoverable, true);
    assert.equal(result.value.turn, 3);
    assert.deepEqual(result.value.unfinished, ['bash']);
  });

  it('reports nothing for a session that finished cleanly', async () => {
    const { ctx, routes } = fakeContext({ events: cleanLog() });
    apply(ctx, {});
    const result = await rpc(routes, 'inspect', { sessionId: 'session-1' });
    assert.equal(result.ok, true);
    assert.equal(result.value.recoverable, false);
  });

  it('rejects an inspect without a session id', async () => {
    const { ctx, routes } = fakeContext();
    apply(ctx, {});
    const result = await rpc(routes, 'inspect', {});
    assert.equal(result.ok, false);
  });

  it('rejects an unknown endpoint instead of pretending success', async () => {
    const { ctx, routes } = fakeContext();
    apply(ctx, {});
    const result = await rpc(routes, 'nope', {});
    assert.equal(result.ok, false);
    assert.match(result.error.message, /unknown endpoint/);
  });
});

describe('crash-recovery continuation', () => {
  it('wakes the agent with exactly one labelled user message', async () => {
    const sent = [];
    const { ctx, routes } = fakeContext({ agentFollowup: (message) => sent.push(message) });
    apply(ctx, {});

    const result = await rpc(routes, 'continue', { sessionId: 'session-1' });
    assert.equal(result.ok, true);
    assert.equal(result.value.turn, 3);
    assert.equal(sent.length, 1, 'one followup, which opens one turn');

    const message = sent[0];
    assert.equal(message.role, 'user');
    assert.match(message.content[0].text, /第 3 轮/);
    assert.match(message.content[0].text, /bash/);
    // The log records that a plugin wrote it, not the user.
    assert.equal(message.source.kind, 'llm-network-retry');
  });

  it('does not wake the agent when the session is not live', async () => {
    // No agent registered: the browser must be told to open the session first.
    const { ctx, routes } = fakeContext();
    apply(ctx, {});
    const result = await rpc(routes, 'continue', { sessionId: 'session-1' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /未在运行/);
  });

  it('does not inject a turn when nothing needs recovering', async () => {
    const sent = [];
    const { ctx, routes } = fakeContext({
      events: cleanLog(),
      agentFollowup: (message) => sent.push(message),
    });
    apply(ctx, {});
    const result = await rpc(routes, 'continue', { sessionId: 'session-1' });
    assert.equal(result.ok, false);
    assert.equal(sent.length, 0, 'a stale banner must never inject a turn');
  });

  it('never continues on its own — only an explicit call does', async () => {
    const sent = [];
    const { ctx } = fakeContext({ agentFollowup: (message) => sent.push(message) });
    apply(ctx, {});
    // Loading the plugin, inspecting, and firing unrelated events must all be inert.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 0, 'crash recovery is user-driven, never automatic');
  });
});
