/**
 * Crash-recovery Host operation — "continue the turn a process death interrupted".
 *
 * Two ways in, one operation:
 *
 *   * **Automatically at boot**, when a session is opened for the first time
 *     after a restart (`source === 'startup'`) and its log ends `interrupted`.
 *     This is the requested behavior: a crash should not leave you with a dead
 *     conversation you have to nudge back to life.
 *   * **By hand**, through the Chat banner, for every other case (`resume`,
 *     `clear`, `compact`) and after the automatic path has been used once.
 *
 * Both write the same durable message through `agent.followup()`, which is the
 * documented way for a plugin to wake an agent with a new turn. Neither goes
 * through `sessionController.prompt()`: that path mints a `user-rpc` message
 * source, which would make plugin text indistinguishable from your own typing.
 *
 * The safety property that makes automatic continuation defensible: the message
 * tells the model, in its first line, that a process death happened and that
 * tool outcomes are unknown, and orders it to verify real state before retrying
 * anything with side effects. Plus `recoverable(..., { automatic: true })`
 * refuses a turn this plugin already continued, so a crash that reproduces on
 * every boot cannot become an infinite restart loop.
 *
 * The continuation goes through `agent.followup()`, the documented way for a
 * plugin to wake an agent with a new turn. It deliberately does not go through
 * `sessionController.prompt()`: that path mints a `user-rpc` message source, which
 * would make plugin text look exactly like something you typed.
 *
 * @module dsh-llm-network-retry/host
 */

import { randomUUID } from 'node:crypto';

import { CONTINUATION_SOURCE, continueMessage, recoverable } from './resume.js';

/** Source tag recorded on plugin-authored user messages. */
const SOURCE_KIND = CONTINUATION_SOURCE;

/**
 * Build the durable user message a plugin-authored continuation appends.
 *
 * The session log is the only source of truth, so this message has to reconstruct
 * on replay. Its shape follows what `Session.append('user/message', …)` validates
 * (an identified message, the right role, array content, and a non-empty
 * `source.kind`) — verified against the installed harness rather than assumed.
 *
 * @param recovery - the recovery summary naming the interrupted turn.
 * @returns a frozen user message.
 */
export function continuationMessage(recovery) {
  return Object.freeze({
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: Object.freeze([
      Object.freeze({
        type: 'text',
        text: continueMessage({
          turn: recovery.turn,
          unfinished: recovery.unfinished,
          automatic: recovery.automatic === true,
        }),
      }),
    ]),
    source: Object.freeze({
      kind: SOURCE_KIND,
      plugin: 'llm-network-retry',
      // Marks the automatic boot path so a human reading the log can tell the
      // two apart without guessing from the wording.
      automatic: recovery.automatic === true,
    }),
  });
}

/**
 * Read one session's durable log and report whether it ended interrupted.
 *
 * Reads through persistence rather than a live agent, so a cold session — the
 * normal case right after a crash — can be inspected without activating it.
 * Returns `undefined` on any read failure: a session that cannot be opened is
 * not something this plugin should claim to be able to fix.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - durable session identity.
 * @param signal - caller cancellation.
 * @param options - `automatic` applies the restart-loop guard.
 * @returns the recovery summary, or `undefined`.
 */
export async function inspectSession(persistence, sessionId, signal, options = {}) {
  if (persistence === undefined) return undefined;
  let handle;
  try {
    handle = await persistence.open(sessionId, 'read', { signal });
    const read = await handle.read(0, undefined, { signal });
    return recoverable(read.events, options);
  } catch {
    return undefined;
  } finally {
    try {
      await handle?.close?.();
    } catch {
      // A failed close on a read handle is not worth surfacing.
    }
  }
}

/**
 * Wake one live agent to continue its interrupted turn.
 *
 * Re-checks the log instead of trusting the caller's summary, so a stale banner
 * cannot inject a spurious turn after you already continued some other way. That
 * re-check is also what makes the operation idempotent for a double click: the
 * first continuation opens a new turn, and the second sees nothing to recover.
 *
 * @param options - live agent, persistence for the re-check, cancellation, and
 *   whether this call is the automatic boot path.
 * @returns what was accepted, or why nothing was.
 */
export async function continueInterrupted({ agent, persistence, signal, automatic = false }) {
  if (agent === undefined || typeof agent.followup !== 'function') {
    return { ok: false, reason: 'agent-unavailable' };
  }
  const recovery = await inspectSession(
    persistence,
    agent.id,
    signal,
    automatic ? { automatic: true } : {},
  );
  if (recovery === undefined) {
    return { ok: false, reason: automatic ? 'nothing-to-recover-or-already-continued' : 'nothing-to-recover' };
  }
  agent.followup(continuationMessage({ ...recovery, automatic }));
  return {
    ok: true,
    automatic,
    turn: recovery.turn,
    unfinished: recovery.unfinishedNames,
  };
}
