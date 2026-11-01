/**
 * Crash recovery tested against the REAL Cordis runtime.
 *
 * The earlier fake-context tests were a false friend: a hand-written `inject`
 * stub happily runs a callback that real Cordis would refuse. Two bugs hid
 * behind that — a nested `ctx.inject` that never fired, and `ctx.agents` read
 * from the root context instead of the injected scope, which the real runtime
 * rejects with "cannot get property ... without inject".
 *
 * So this file boots actual services with actual `Service` subclasses and calls
 * the plugin's RPC handler the way the browser half does. If Cordis would refuse
 * the composition, these tests fail instead of passing on a stub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply } from '../lib/index.js';

const BASE =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai';

/**
 * Load the real Cordis runtime. Returns `null` when this machine has no dsh
 * installation, so the suite degrades to a skip rather than a hard failure.
 */
async function loadCordis() {
  try {
    return await import(`${BASE}/cordis/lib/index.js`);
  } catch {
    return null;
  }
}

/** One committed session event. */
function event(type, data = {}, seq = 0) {
  return { type, seq, time: 0, data };
}

/** A log whose trailing turn was interrupted, with one tool left open. */
function interruptedLog() {
  return [
    event('turn/start', { turn: 7 }, 0),
    event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }, 1),
    event('turn/end', { turn: 7, reason: { kind: 'interrupted' } }, 2),
  ];
}

/** A log that finished normally. */
function cleanLog() {
  return [event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 0)];
}

/**
 * Boot the plugin on a real Cordis Context with real services.
 * @returns the RPC channel map and the array of messages the agent received.
 */
async function boot({ events = interruptedLog(), agents: agentIds = ['s1'], cordis } = {}) {
  const { Context, Service } = cordis;
  const routes = new Map();
  const sent = [];

  class Persistence extends Service {
    constructor(ctx) {
      super(ctx, 'sessionPersistence');
    }
    async open() {
      return {
        async read() {
          return { events };
        },
        async close() {},
      };
    }
  }

  class Connection extends Service {
    constructor(ctx) {
      super(ctx, 'connection');
      this.rpc = {
        handle(channel, handler) {
          routes.set(channel, handler);
          return async () => routes.delete(channel);
        },
      };
    }
  }

  class WebServer extends Service {
    constructor(ctx) {
      super(ctx, 'webServer');
    }
  }

  class Agents extends Service {
    constructor(ctx) {
      super(ctx, 'agents');
      this.live = new Map(
        agentIds.map((id) => [id, { id, followup: (message) => sent.push(message) }]),
      );
    }
    get(id) {
      return this.live.get(id);
    }
  }

  const app = new Context({ name: 'test-root' });
  app.plugin({ name: 'persistence', apply: (ctx) => void new Persistence(ctx) });
  app.plugin({ name: 'connection', apply: (ctx) => void new Connection(ctx) });
  app.plugin({ name: 'web-server', apply: (ctx) => void new WebServer(ctx) });
  app.plugin({ name: 'agents', apply: (ctx) => void new Agents(ctx) });
  app.plugin({ name: 'network-retry', apply: (ctx) => apply(ctx, {}) });

  // Cordis settles fibers asynchronously; give the composition one macrotask.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { routes, sent };
}

/** Invoke the plugin's RPC handler the way the browser half does. */
function rpc(routes, endpoint, payload) {
  const handler = routes.get('/llm-network-retry');
  assert.ok(handler, 'the plugin registered its RPC channel under real Cordis');
  return handler(endpoint, payload);
}

describe('crash recovery on the real runtime', { concurrency: false }, () => {
  it('registers its RPC channel under real service composition', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { routes } = await boot({ cordis });
    assert.deepEqual([...routes.keys()], ['/llm-network-retry']);
  });

  it('reports the interrupted turn and the tools left mid-flight', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { routes } = await boot({ cordis });
    const result = await rpc(routes, 'inspect', { sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { recoverable: true, turn: 7, unfinished: ['bash'] });
  });

  it('reports nothing for a session that finished cleanly', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { routes } = await boot({ cordis, events: cleanLog() });
    const result = await rpc(routes, 'inspect', { sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.equal(result.value.recoverable, false);
  });

  it('wakes the agent with one labelled user message', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { routes, sent } = await boot({ cordis });

    const result = await rpc(routes, 'continue', { sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);

    const message = sent[0];
    assert.equal(message.role, 'user');
    assert.equal(typeof message.id, 'string');
    assert.equal(message.source.kind, 'llm-network-retry');
    assert.match(message.content[0].text, /第 7 轮/);
    assert.match(message.content[0].text, /bash/);
    assert.match(message.content[0].text, /不是你本人新写的指令/);
  });

  it('refuses a session that is not live, instead of pretending', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { routes, sent } = await boot({ cordis, agents: [] });
    const result = await rpc(routes, 'continue', { sessionId: 's1' });
    assert.equal(result.ok, false);
    assert.equal(sent.length, 0);
  });

  it('does not inject a turn for a clean session', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { routes, sent } = await boot({ cordis, events: cleanLog() });
    const result = await rpc(routes, 'continue', { sessionId: 's1' });
    assert.equal(result.ok, false);
    assert.equal(sent.length, 0, 'nothing to recover means nothing is sent');
  });

  it('never continues on its own', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { sent } = await boot({ cordis });
    // Booting the composition alone must be inert.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sent.length, 0, 'crash recovery is user-driven, never automatic');
  });

  it('rejects an unknown endpoint', async (t) => {
    const cordis = await loadCordis();
    if (cordis === null) return t.skip('no dsh installation to load Cordis from');
    const { routes } = await boot({ cordis });
    const result = await rpc(routes, 'nope', {});
    assert.equal(result.ok, false);
  });
});
