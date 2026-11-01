import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULTS,
  PRESETS,
  chooseDelay,
  classify,
  computeDelay,
  decide,
  inScope,
  policyKey,
  resolveConfig,
} from '../lib/policy.js';

/** A deterministic `random` so jitter never makes a test flaky. */
const noJitter = () => 0.5;

describe('resolveConfig', () => {
  it('defaults to the Codex shape: unbounded connection retries, bounded everything else', () => {
    const resolved = resolveConfig();
    assert.equal(resolved.preset, PRESETS.codex);
    assert.equal(resolved.unboundedConnectionRetries, true);
    assert.equal(resolved.maxRetries, 5);
    assert.equal(resolved.honorRetryAfter, true);
    assert.equal(resolved.respectProviderPolicy, true);
    assert.deepEqual(resolved.connectionCodes, ['TRANSPORT', 'TIMEOUT', 'NETWORK']);
  });

  it('rejects an unknown option rather than silently ignoring a typo', () => {
    assert.throws(() => resolveConfig({ maxRetires: 3 }), /unknown option "maxRetires"/);
  });

  it('rejects a malformed preset', () => {
    assert.throws(() => resolveConfig({ preset: 'yolo' }), /preset must be one of/);
  });

  it('rejects a negative retry budget', () => {
    assert.throws(() => resolveConfig({ maxRetries: -1 }), /non-negative integer/);
  });

  it('rejects a backoff whose ceiling is below its floor', () => {
    assert.throws(
      () => resolveConfig({ requestBackoff: { initialDelayMs: 5000, maxDelayMs: 100 } }),
      /maxDelayMs must be between initialDelayMs/,
    );
  });

  it('rejects a jitter ratio outside 0..1', () => {
    assert.throws(() => resolveConfig({ requestBackoff: { jitterRatio: 2 } }), /jitterRatio/);
  });

  it('de-duplicates code lists so a budget cannot be consumed twice by one code', () => {
    const resolved = resolveConfig({ retryableCodes: ['SERVER', 'SERVER', 'TRANSPORT'] });
    assert.deepEqual(resolved.retryableCodes, ['SERVER', 'TRANSPORT']);
  });

  it('accepts a config that only narrows scope', () => {
    const resolved = resolveConfig({ providers: ['tencent-intranet'] });
    assert.deepEqual(resolved.providers, ['tencent-intranet']);
    assert.equal(resolved.preset, PRESETS.codex);
  });
});

describe('classify', () => {
  const resolved = resolveConfig();

  it('treats connection failures as connection problems', () => {
    assert.equal(classify(resolved, { code: 'TRANSPORT' }), 'connection');
    assert.equal(classify(resolved, { code: 'TIMEOUT' }), 'connection');
  });

  it('treats a rate limit as retryable, not unbounded by default', () => {
    assert.equal(classify(resolved, { code: 'RATE_LIMIT' }), 'retryable');
  });

  it('never retries auth or context failures', () => {
    for (const code of ['AUTH', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'QUOTA']) {
      assert.equal(classify(resolved, { code }), 'fatal', code);
    }
  });

  it('reports an unlisted code as unknown', () => {
    assert.equal(classify(resolved, { code: 'SOMETHING_NEW' }), 'unknown');
  });

  it('survives a failure with no code at all', () => {
    assert.equal(classify(resolved, {}), 'unknown');
  });
});

describe('inScope', () => {
  it('matches every provider when no scope is configured', () => {
    assert.equal(inScope(resolveConfig(), 'anything', 'any-model'), true);
  });

  it('narrows to a configured provider list', () => {
    const resolved = resolveConfig({ providers: ['tencent-intranet'] });
    assert.equal(inScope(resolved, 'tencent-intranet', 'm'), true);
    assert.equal(inScope(resolved, 'deepseek', 'm'), false);
  });

  it('narrows to a configured model list', () => {
    const resolved = resolveConfig({ models: ['deepseek-v4.1-flash-ioa'] });
    assert.equal(inScope(resolved, 'p', 'deepseek-v4.1-flash-ioa'), true);
    assert.equal(inScope(resolved, 'p', 'other'), false);
  });
});

describe('computeDelay', () => {
  it('waits the initial delay on the first retry', () => {
    assert.equal(computeDelay(DEFAULTS.requestBackoff, 1, noJitter), 500);
  });

  it('doubles each attempt', () => {
    assert.equal(computeDelay(DEFAULTS.requestBackoff, 2, noJitter), 1000);
    assert.equal(computeDelay(DEFAULTS.requestBackoff, 3, noJitter), 2000);
  });

  it('never exceeds the configured ceiling', () => {
    assert.equal(computeDelay(DEFAULTS.requestBackoff, 50, noJitter), 10_000);
  });

  it('applies jitter within the configured band', () => {
    const low = computeDelay(DEFAULTS.requestBackoff, 1, () => 0);
    const high = computeDelay(DEFAULTS.requestBackoff, 1, () => 0.999);
    assert.ok(low >= 450 && low <= 500, `low=${low}`);
    assert.ok(high >= 500 && high <= 550, `high=${high}`);
  });

  it('walks the connection ladder from 5s toward 60s', () => {
    assert.equal(computeDelay(DEFAULTS.connectionBackoff, 1, noJitter), 5000);
    assert.equal(computeDelay(DEFAULTS.connectionBackoff, 2, noJitter), 10_000);
    assert.equal(computeDelay(DEFAULTS.connectionBackoff, 4, noJitter), 40_000);
    assert.equal(computeDelay(DEFAULTS.connectionBackoff, 5, noJitter), 60_000);
    assert.equal(computeDelay(DEFAULTS.connectionBackoff, 500, noJitter), 60_000);
  });
});

describe('chooseDelay', () => {
  const resolved = resolveConfig();

  it('honors a provider Retry-After inside the ceiling', () => {
    const delay = chooseDelay(resolved, {
      backoff: resolved.requestBackoff,
      retry: 1,
      failure: { providerRetryAfterMs: 3000 },
      random: noJitter,
    });
    assert.equal(delay, 3000);
  });

  it('ignores a Retry-After beyond the ceiling and falls back to local backoff', () => {
    const delay = chooseDelay(resolved, {
      backoff: resolved.requestBackoff,
      retry: 1,
      failure: { providerRetryAfterMs: 600_000 },
      random: noJitter,
    });
    assert.equal(delay, 500);
  });

  it('ignores a nonsense Retry-After', () => {
    for (const value of [0, -1, Number.NaN, Infinity, 'soon']) {
      const delay = chooseDelay(resolved, {
        backoff: resolved.requestBackoff,
        retry: 1,
        failure: { providerRetryAfterMs: value },
        random: noJitter,
      });
      assert.equal(delay, 500, String(value));
    }
  });

  it('can be told not to trust Retry-After', () => {
    const strict = resolveConfig({ honorRetryAfter: false });
    const delay = chooseDelay(strict, {
      backoff: strict.requestBackoff,
      retry: 1,
      failure: { providerRetryAfterMs: 3000 },
      random: noJitter,
    });
    assert.equal(delay, 500);
  });
});

describe('decide', () => {
  const base = { retry: 0, random: noJitter, elapsedMs: 0, provider: 'p', model: 'm' };

  it('retries a connection failure without an attempt limit in codex preset', () => {
    const resolved = resolveConfig();
    const plan = decide(resolved, {
      ...base,
      previousRetry: 9999,
      failure: { code: 'TRANSPORT' },
    });
    assert.equal(plan.kind, 'retry');
    assert.equal(plan.mode, 'always');
    assert.equal(plan.retry, 10_000);
    assert.equal(plan.delayMs, 60_000);
  });

  it('bounds a server failure', () => {
    const resolved = resolveConfig();
    const first = decide(resolved, { ...base, previousRetry: 0, failure: { code: 'SERVER' } });
    assert.equal(first.kind, 'retry');
    assert.equal(first.mode, 'normal');
    assert.equal(first.maxRetries, 5);

    const last = decide(resolved, { ...base, previousRetry: 5, failure: { code: 'SERVER' } });
    assert.equal(last.kind, 'delegate');
    assert.equal(last.reason, 'exhausted');
  });

  it('never retries a fatal code, whatever the preset', () => {
    for (const preset of Object.values(PRESETS)) {
      const resolved = resolveConfig({ preset });
      const plan = decide(resolved, { ...base, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } });
      assert.equal(plan.kind, 'delegate', preset);
      assert.equal(plan.reason, 'fatal', preset);
    }
  });

  it('never retries an aborted turn', () => {
    const resolved = resolveConfig({ preset: PRESETS.always });
    const plan = decide(resolved, { ...base, aborted: true, failure: { code: 'TRANSPORT' } });
    assert.equal(plan.kind, 'delegate');
    assert.equal(plan.reason, 'aborted');
  });

  it('delegates an unknown code unless the preset retries everything', () => {
    const codex = decide(resolveConfig(), { ...base, failure: { code: 'MYSTERY' } });
    assert.equal(codex.reason, 'unknown-code');

    const always = decide(resolveConfig({ preset: 'always' }), {
      ...base,
      failure: { code: 'MYSTERY' },
    });
    assert.equal(always.kind, 'retry');
  });

  it('respects the configured provider/model scope', () => {
    const resolved = resolveConfig({ providers: ['other'] });
    const plan = decide(resolved, { ...base, failure: { code: 'TRANSPORT' } });
    assert.equal(plan.reason, 'out-of-scope');
  });

  it('leaves an adapter that already runs unlimited recovery alone', () => {
    const plan = decide(resolveConfig(), {
      ...base,
      providerPolicy: { mode: 'always' },
      failure: { code: 'TRANSPORT' },
    });
    assert.equal(plan.kind, 'delegate');
    assert.equal(plan.reason, 'provider-always');
  });

  it('can take over from an adapter that runs unlimited recovery', () => {
    const resolved = resolveConfig({ respectProviderPolicy: false });
    const plan = decide(resolved, {
      ...base,
      providerPolicy: { mode: 'always' },
      failure: { code: 'TRANSPORT' },
    });
    assert.equal(plan.kind, 'retry');
  });

  it('stops unbounded recovery at the configured wait ceiling', () => {
    const resolved = resolveConfig({ maxUnboundedWaitMs: 60_000 });
    const early = decide(resolved, {
      ...base,
      elapsedMs: 30_000,
      failure: { code: 'TRANSPORT' },
    });
    assert.equal(early.kind, 'retry');

    const late = decide(resolved, {
      ...base,
      elapsedMs: 60_001,
      failure: { code: 'TRANSPORT' },
    });
    assert.equal(late.kind, 'delegate');
    assert.equal(late.reason, 'wait-ceiling');
  });
});

describe('policyKey', () => {
  it('is stable for identical policy shapes', () => {
    const key = policyKey(resolveConfig(), 'always');
    assert.equal(key, policyKey(resolveConfig(), 'always'));
  });

  it('changes when the budget changes, so a new chain starts', () => {
    assert.notEqual(policyKey(resolveConfig(), 'normal'), policyKey(resolveConfig({ maxRetries: 9 }), 'normal'));
  });

  it('separates the bounded and unbounded chains', () => {
    assert.notEqual(policyKey(resolveConfig(), 'normal'), policyKey(resolveConfig(), 'always'));
  });
});
