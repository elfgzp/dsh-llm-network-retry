/**
 * Pure retry-decision policy — no Host services, no timers, no session.
 *
 * The semantics model OpenAI Codex CLI (`codex-rs`), where retry is a two-layer
 * affair: a bounded request layer (`request_max_retries = 4`, exponential
 * backoff from 200 ms, ±10 % jitter, honors `Retry-After`) and a stream layer
 * whose *connection* failures are retried without any attempt limit at 5 s → 60 s
 * (`unbounded_connection_retries`, enabled by default).
 *
 * Two deliberate differences from Codex, both because this runs inside DeepSeek
 * Harness instead of a terminal UI:
 *
 *   1. Durable before wait. A scheduled attempt is appended to the session log
 *      before any timer starts, so a crash or a cancel never leaves an invisible
 *      pending retry, and the Chat UI renders the native retry row (countdown,
 *      attempt number, failure reason) that shipped plugins already use.
 *   2. Cancellation is a first-class stop. A user interrupt aborts the wait
 *      immediately; nothing here retries an aborted turn.
 *
 * @module dsh-llm-network-retry/policy
 */

/** Retry presets, mirroring Codex's bounded/unbounded split. */
export const PRESETS = Object.freeze({
  /** Codex default: connection failures retry forever, everything else is bounded. */
  codex: 'codex',
  /** Everything that is not fatal retries forever. */
  always: 'always',
  /** Everything that is not fatal is bounded by `maxRetries`. */
  normal: 'normal',
});

/** Codes that mean "the network or the stream broke", not "the request was wrong". */
const DEFAULT_CONNECTION_CODES = Object.freeze(['TRANSPORT', 'TIMEOUT', 'NETWORK']);

/** Codes worth a bounded retry: transient server/transport conditions. */
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'NETWORK',
]);

/**
 * Codes that must never be retried. Retrying these only burns billing and time:
 * the request itself is unacceptable, the account cannot pay, the turn was
 * aborted by the user, or the harness needs a human decision.
 */
const DEFAULT_FATAL_CODES = Object.freeze([
  'ABORTED',
  'INTERRUPTED',
  'AUTH',
  'INVALID_CREDENTIAL',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_SIGNED_OUT',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'USAGE_LIMIT_REACHED',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REQUEST',
  'INVALID_REPLAY_STATE',
  'IMAGE_OFFLOAD_REQUIRED',
]);

/** Backoff used for bounded retries — Codex's request layer shape. */
const DEFAULT_REQUEST_BACKOFF = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  multiplier: 2,
});

/** Backoff used for unbounded connection recovery — Codex's 5 s → 60 s shape. */
const DEFAULT_CONNECTION_BACKOFF = Object.freeze({
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.1,
  multiplier: 2,
});

/** Largest timer Node accepts; the same ceiling `dsh-llm` enforces. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Validate a plain object and reject unknown keys, so a typo in the profile
 * patch fails loudly at activation instead of silently doing nothing.
 * @param value - candidate object.
 * @param allowed - accepted key names.
 * @param path - diagnostic path prefix.
 */
function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${path}: unknown option "${key}" (accepted: ${[...allowed].join(', ')})`,
      );
    }
  }
}

/** True for a plain (non-array) object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one string list, rejecting non-arrays and empty strings.
 * @param value - candidate list or `undefined`.
 * @param fallback - value used when the option is omitted.
 * @param path - diagnostic path.
 * @returns a detached, de-duplicated list.
 */
function stringList(value, fallback, path) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings`);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${path} must contain only non-empty strings`);
    }
  }
  return [...new Set(value)];
}

/**
 * Normalize one backoff block.
 * @param value - candidate configuration or `undefined`.
 * @param fallback - defaults for omitted fields.
 * @param path - diagnostic path.
 * @returns a frozen, validated backoff.
 */
function backoffBlock(value, fallback, path) {
  if (value === undefined) return Object.freeze({ ...fallback });
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertKnownKeys(value, new Set(Object.keys(fallback)), path);
  const merged = { ...fallback };
  for (const key of Object.keys(fallback)) {
    if (value[key] === undefined) continue;
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new Error(`${path}.${key} must be a finite number`);
    }
    merged[key] = number;
  }
  if (merged.initialDelayMs <= 0 || merged.initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive number`);
  }
  if (merged.maxDelayMs < merged.initialDelayMs || merged.maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be between initialDelayMs and ${MAX_TIMER_DELAY_MS}`);
  }
  if (merged.jitterRatio < 0 || merged.jitterRatio > 1) {
    throw new Error(`${path}.jitterRatio must be between 0 and 1`);
  }
  if (merged.multiplier < 1) throw new Error(`${path}.multiplier must be at least 1`);
  return Object.freeze(merged);
}

/**
 * Normalize the row `config` into the resolved form the executor reads.
 *
 * Everything is optional: an empty object is the Codex-shaped default, which is
 * what "keep retrying while the network is down" means in practice.
 *
 * @param config - raw config from the profile patch; `undefined` is the default.
 * @returns a frozen resolved configuration.
 * @throws when a value is malformed, naming the exact path.
 */
export function resolveConfig(config = {}) {
  if (!isRecord(config)) throw new Error('llm-network-retry: config must be an object');
  assertKnownKeys(
    config,
    new Set([
      'preset',
      'maxRetries',
      'unboundedConnectionRetries',
      'retryableCodes',
      'connectionCodes',
      'fatalCodes',
      'requestBackoff',
      'connectionBackoff',
      'honorRetryAfter',
      'respectProviderPolicy',
      'providers',
      'models',
      'maxUnboundedWaitMs',
    ]),
    'llm-network-retry',
  );

  const preset = config.preset ?? PRESETS.codex;
  if (!Object.values(PRESETS).includes(preset)) {
    throw new Error(
      `llm-network-retry.preset must be one of ${Object.values(PRESETS).join(', ')}`,
    );
  }

  const maxRetries = config.maxRetries ?? 5;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('llm-network-retry.maxRetries must be a non-negative integer');
  }

  const maxUnboundedWaitMs = config.maxUnboundedWaitMs ?? 0;
  if (!Number.isSafeInteger(maxUnboundedWaitMs) || maxUnboundedWaitMs < 0) {
    throw new Error('llm-network-retry.maxUnboundedWaitMs must be a non-negative integer');
  }

  return Object.freeze({
    preset,
    maxRetries,
    unboundedConnectionRetries: config.unboundedConnectionRetries ?? true,
    retryableCodes: Object.freeze(
      stringList(config.retryableCodes, DEFAULT_RETRYABLE_CODES, 'llm-network-retry.retryableCodes'),
    ),
    connectionCodes: Object.freeze(
      stringList(config.connectionCodes, DEFAULT_CONNECTION_CODES, 'llm-network-retry.connectionCodes'),
    ),
    fatalCodes: Object.freeze(
      stringList(config.fatalCodes, DEFAULT_FATAL_CODES, 'llm-network-retry.fatalCodes'),
    ),
    requestBackoff: backoffBlock(
      config.requestBackoff,
      DEFAULT_REQUEST_BACKOFF,
      'llm-network-retry.requestBackoff',
    ),
    connectionBackoff: backoffBlock(
      config.connectionBackoff,
      DEFAULT_CONNECTION_BACKOFF,
      'llm-network-retry.connectionBackoff',
    ),
    honorRetryAfter: config.honorRetryAfter ?? true,
    respectProviderPolicy: config.respectProviderPolicy ?? true,
    providers: Object.freeze(
      stringList(config.providers, [], 'llm-network-retry.providers'),
    ),
    models: Object.freeze(stringList(config.models, [], 'llm-network-retry.models')),
    maxUnboundedWaitMs,
  });
}

/**
 * Decide whether one provider is in scope.
 * @param resolved - resolved configuration.
 * @param provider - the provider route named by the failed request.
 * @param model - the model named by the failed request, when known.
 * @returns whether this failure belongs to this plugin.
 */
export function inScope(resolved, provider, model) {
  if (resolved.providers.length > 0 && !resolved.providers.includes(provider)) return false;
  if (resolved.models.length > 0 && !resolved.models.includes(model)) return false;
  return true;
}

/**
 * Classify one failure into the executor's vocabulary.
 * @param resolved - resolved configuration.
 * @param failure - the failed attempt's `LlmFailure`.
 * @returns `'fatal'`, `'connection'`, `'retryable'`, or `'unknown'`.
 */
export function classify(resolved, failure) {
  const code = typeof failure?.code === 'string' ? failure.code : 'UNKNOWN';
  if (resolved.fatalCodes.includes(code)) return 'fatal';
  if (resolved.connectionCodes.includes(code)) return 'connection';
  if (resolved.retryableCodes.includes(code)) return 'retryable';
  return 'unknown';
}

/**
 * Bounded exponential backoff with symmetric jitter, capped at `maxDelayMs`.
 * Attempt 1 waits `initialDelayMs` (Codex's `base * 2^(attempt-1)` shape).
 *
 * @param backoff - validated backoff block.
 * @param retry - 1-based retry ordinal.
 * @param random - `[0, 1)` source; injected for deterministic tests.
 * @returns the delay in milliseconds.
 */
export function computeDelay(backoff, retry, random = Math.random) {
  const exponent = Math.min(Math.max(retry - 1, 0), 1024);
  const exponential = Math.min(backoff.initialDelayMs * backoff.multiplier ** exponent, backoff.maxDelayMs);
  const jitter = 1 - backoff.jitterRatio + 2 * backoff.jitterRatio * random();
  return Math.max(1, Math.min(Math.round(exponential * jitter), backoff.maxDelayMs));
}

/**
 * Choose the wait for one scheduled attempt.
 *
 * A valid provider `Retry-After` wins over local backoff — that is the whole
 * point of the header — but only when it fits inside the policy's ceiling; an
 * over-ceiling instruction falls back to local backoff instead of ending the
 * retry chain (Codex's bounded layer declines, its unbounded layer substitutes).
 *
 * @param resolved - resolved configuration.
 * @param options - the attempt being scheduled.
 * @returns the delay in milliseconds.
 */
export function chooseDelay(resolved, options) {
  const { backoff, retry, failure, random } = options;
  const retryAfter = failure?.providerRetryAfterMs;
  if (
    resolved.honorRetryAfter &&
    typeof retryAfter === 'number' &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0 &&
    retryAfter <= backoff.maxDelayMs
  ) {
    return Math.max(1, Math.round(retryAfter));
  }
  return computeDelay(backoff, retry, random);
}

/**
 * Decide what to do with one failed model request.
 *
 * Order of authority:
 *   1. A user abort or an out-of-scope route is never ours to retry.
 *   2. Fatal codes are never retried, whatever the preset says.
 *   3. A provider that registered `always` already owns unlimited recovery; when
 *      `respectProviderPolicy` is on (the default) this plugin delegates so one
 *      failure does not run two independent retry chains.
 *   4. Otherwise the preset decides: `always` retries everything not fatal;
 *      `codex` retries connection failures forever and everything else up to
 *      `maxRetries`; `normal` never retries forever.
 *
 * @param resolved - resolved configuration.
 * @param attempt - one failed attempt and its context.
 * @returns a plan describing the retry, or `{ kind: 'delegate' }`.
 */
export function decide(resolved, attempt) {
  const { failure, providerPolicy, previousRetry, aborted } = attempt;
  if (aborted) return Object.freeze({ kind: 'delegate', reason: 'aborted' });
  if (!inScope(resolved, attempt.provider, attempt.model)) {
    return Object.freeze({ kind: 'delegate', reason: 'out-of-scope' });
  }

  const category = classify(resolved, failure);
  if (category === 'fatal') return Object.freeze({ kind: 'delegate', reason: 'fatal' });

  // The adapter already runs its own unlimited chain for this route; a second
  // chain would double the request rate against the same failing endpoint.
  if (resolved.respectProviderPolicy && providerPolicy?.mode === 'always') {
    return Object.freeze({ kind: 'delegate', reason: 'provider-always' });
  }

  const unbounded =
    resolved.preset === PRESETS.always ||
    (category === 'connection' &&
      resolved.preset === PRESETS.codex &&
      resolved.unboundedConnectionRetries);

  if (!unbounded) {
    if (category === 'unknown') return Object.freeze({ kind: 'delegate', reason: 'unknown-code' });
    if (previousRetry >= resolved.maxRetries) {
      return Object.freeze({ kind: 'delegate', reason: 'exhausted' });
    }
  }

  const retry = previousRetry + 1;
  const mode = unbounded ? 'always' : 'normal';
  const backoff = unbounded ? resolved.connectionBackoff : resolved.requestBackoff;
  if (
    unbounded &&
    resolved.maxUnboundedWaitMs > 0 &&
    attempt.elapsedMs >= resolved.maxUnboundedWaitMs
  ) {
    return Object.freeze({ kind: 'delegate', reason: 'wait-ceiling' });
  }

  const delayMs = chooseDelay(resolved, {
    backoff,
    retry,
    failure,
    random: attempt.random,
  });

  return Object.freeze({
    kind: 'retry',
    retry,
    mode,
    delayMs,
    category,
    ...(mode === 'normal' ? { maxRetries: resolved.maxRetries } : {}),
  });
}

/**
 * Stable identity of one policy shape, so a changed `config` starts a fresh
 * retry chain instead of inheriting the previous one's budget.
 * @param resolved - resolved configuration.
 * @param mode - the mode this chain runs in.
 * @returns a deterministic key.
 */
export function policyKey(resolved, mode) {
  const backoff = mode === 'always' ? resolved.connectionBackoff : resolved.requestBackoff;
  return JSON.stringify([
    'dsh-llm-network-retry',
    mode,
    mode === 'normal' ? resolved.maxRetries : null,
    resolved.fatalCodes,
    resolved.connectionCodes,
    backoff.initialDelayMs,
    backoff.maxDelayMs,
    backoff.jitterRatio,
    backoff.multiplier,
  ]);
}

/** Exported for tests and documentation. */
export const DEFAULTS = Object.freeze({
  connectionCodes: DEFAULT_CONNECTION_CODES,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  fatalCodes: DEFAULT_FATAL_CODES,
  requestBackoff: DEFAULT_REQUEST_BACKOFF,
  connectionBackoff: DEFAULT_CONNECTION_BACKOFF,
});
