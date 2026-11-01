/**
 * dsh-llm-network-retry — Host half.
 *
 * Why this plugin exists next to the shipped `@deepseek-ai/dsh-llm-retry`:
 *
 *   * The shipped executor is bounded by the *provider* `retryPolicy`. Its
 *     default (`normal`, 5 retries) gives up after roughly ten seconds of
 *     backoff, which is shorter than a laptop waking from sleep, a VPN
 *     reconnect, or a flaky hotel Wi-Fi handshake. When it gives up, the turn
 *     dies and the user has to retype "继续".
 *   * Codex CLI solves the same problem with one specific rule: a
 *     *connection* failure (`ConnectionFailed`) is retried **without any attempt
 *     limit**, 5 s rising to 60 s, until the network comes back
 *     (`unbounded_connection_retries`, enabled by default). Everything else
 *     stays bounded so a real 400/auth/context error still fails fast.
 *
 * This plugin implements that rule on the same extension point the shipped
 * executor uses — the `agent/request-error` waterfall — and appends the same
 * `llm/retry` / `llm/retry-started` session events, so the Chat UI renders its
 * native retry row (countdown, attempt number, failure reason) with no client
 * half at all. Cancelling the turn stops the wait immediately.
 *
 * The plugin prepends itself, so it decides *before* the shipped executor:
 * connection failures become one unlimited chain instead of "5 bounded retries,
 * then a second chain from this plugin". Every other failure is delegated
 * downstream with `next()`, which is where the shipped executor's normal mode
 * keeps working unchanged.
 *
 * @module dsh-llm-network-retry
 */

import {
  PRESETS,
  decide,
  policyKey,
  resolveConfig,
} from './policy.js';

export const name = 'llm-network-retry';

/**
 * `agents` for `ctx.logger`-independent agent registry access is not needed —
 * the waterfall payload carries the Agent. The session surface is reached
 * through `agent.session`, so no Host service has to be injected.
 */
export const inject = [];

/** Retry-chain identity, minted once per step so the UI groups the attempts. */
function mintRetryId() {
  return `netretry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Wait for `delayMs`, resolving `true` when the wait completed and `false` when
 * the signal aborted first. Never rejects.
 * @param delayMs - milliseconds to wait.
 * @param signal - turn signal fused with the plugin lifetime.
 * @returns whether the wait ran to completion.
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Plugin entry point.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param config - raw profile-patch config; an empty object means Codex defaults.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);

  /**
   * Per-session retry chain, purely an in-memory optimization: durable truth is
   * the `llm/retry` event itself, which is why a restart at worst restarts the
   * attempt numbering.
   */
  const chains = new Map();
  /** In-flight waits, drained on disposal so unload never leaves a timer behind. */
  const active = new Set();
  const lifetime = new AbortController();

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  const disposeReset = ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start' || event.type === 'turn/end') {
      chains.delete(session.id);
    }
  });

  /** The model in force for this step, when the session has logged one. */
  function modelOf(agent) {
    try {
      return agent.session.requestHeader()?.config?.model;
    } catch {
      return undefined;
    }
  }

  /**
   * Append one durable retry record, then wait, then append the "started"
   * marker. Durable before wait: if the append fails, nothing is scheduled.
   * @returns `{ kind: 'retry' }` or `undefined` (delegate).
   */
  async function schedule(payload, plan, chain) {
    const { agent, turn, step, provider, failure, signal } = payload;
    const fused = AbortSignal.any([signal, lifetime.signal]);
    if (fused.aborted) return undefined;

    const eventData = {
      retryId: chain.retryId,
      turn,
      step,
      provider,
      mode: plan.mode,
      policyKey: chain.policyKey,
      retry: plan.retry,
      delayMs: plan.delayMs,
      failure,
      ...(plan.mode === 'normal' ? { maxRetries: plan.maxRetries } : {}),
    };

    try {
      agent.session.append('llm/retry', eventData);
    } catch (error) {
      ctx.logger?.warn?.(
        'llm-network-retry: could not record the scheduled retry, delegating: %o',
        error,
      );
      return undefined;
    }

    ctx.logger?.debug?.(
      'llm-network-retry: %s retry %d for provider "%s" (%s) in %dms',
      plan.mode,
      plan.retry,
      provider,
      plan.category,
      plan.delayMs,
    );

    if (!(await cancellableDelay(plan.delayMs, fused))) return undefined;

    try {
      agent.session.append('llm/retry-started', {
        retryId: chain.retryId,
        turn,
        step,
        retry: plan.retry,
      });
    } catch (error) {
      ctx.logger?.warn?.(
        'llm-network-retry: could not record the retry start, delegating: %o',
        error,
      );
      return undefined;
    }
    return { kind: 'retry' };
  }

  async function recover(payload, next) {
    const { agent, provider, retryPolicy: providerPolicy, signal, failure } = payload;
    if (lifetime.signal.aborted) return undefined;

    const sessionId = agent.id;
    const model = modelOf(agent);

    const existing = chains.get(sessionId);
    // One chain per (turn, step): the loop re-runs the failed step in place, so a
    // bumped step is a different failure and deserves a fresh budget.
    const fresh =
      existing === undefined ||
      existing.turn !== payload.turn ||
      existing.step !== payload.step;

    const base = fresh
      ? { turn: payload.turn, step: payload.step, retry: 0, retryId: undefined, startedAt: Date.now() }
      : existing;

    const plan = decide(resolved, {
      failure,
      providerPolicy,
      provider,
      model,
      previousRetry: base.retry,
      aborted: signal.aborted,
      elapsedMs: Date.now() - base.startedAt,
      random: Math.random,
    });

    if (plan.kind !== 'retry') {
      // An aborted turn is never worth waking the next policy for: the loop
      // re-checks the signal right after the waterfall, so delegating here would
      // only give a downstream executor the chance to schedule a pointless retry.
      if (plan.reason === 'aborted') return undefined;
      ctx.logger?.debug?.(
        'llm-network-retry: delegating provider "%s" failure %s (%s)',
        provider,
        failure?.code,
        plan.reason,
      );
      return next();
    }

    const chain = {
      ...base,
      retry: plan.retry,
      retryId: base.retryId ?? mintRetryId(),
      policyKey: policyKey(resolved, plan.mode),
    };
    chains.set(sessionId, chain);

    const action = await schedule(payload, plan, chain);
    if (action !== undefined) return action;

    // The wait was cancelled, the record could not be written, or the plugin
    // unloaded mid-wait: hand the failure downstream untouched.
    chains.delete(sessionId);
    if (signal.aborted) return undefined;
    return next();
  }

  const disposeListener = ctx.on(
    'agent/request-error',
    (payload, next) => {
      // A waterfall may hold this callback after disposal; fail closed instead
      // of letting a stale chain keep retrying into a dead fiber.
      if (lifetime.signal.aborted) return Promise.resolve(undefined);
      return track(recover(payload, next));
    },
    { prepend: true },
  );

  ctx.effect(
    () => async () => {
      disposeListener();
      disposeReset();
      lifetime.abort(new Error('llm-network-retry disposed'));
      await Promise.allSettled([...active]);
      chains.clear();
    },
    'llm-network-retry: abort and drain active recovery',
  );

  ctx.logger?.info?.(
    'llm-network-retry: preset "%s" (maxRetries %d, unbounded connection retries %s, %s→%s ms)',
    resolved.preset,
    resolved.maxRetries,
    resolved.unboundedConnectionRetries,
    resolved.requestBackoff.initialDelayMs,
    resolved.preset === PRESETS.codex
      ? resolved.connectionBackoff.maxDelayMs
      : resolved.requestBackoff.maxDelayMs,
  );
}
