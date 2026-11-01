/**
 * Crash-recovery Host operation — "continue the turn a process death interrupted".
 *
 * The rule this file exists to enforce: **the user decides, the plugin executes.**
 * A process death can leave side-effecting tool calls mid-flight, so nothing here
 * replays anything by itself. It exposes one operation with two callers — the
 * confirmation banner in the Chat UI and an agent tool — as the Harness
 * guidelines require ("one operation, two callers").
 *
 * The continuation goes through `agent.followup()`, the documented way for a
 * plugin to wake an agent with a new turn. It deliberately does not go through
 * `sessionController.prompt()`: that path mints a `user-rpc` message source, which
 * would make plugin text look exactly like something you typed.
 *
 * @module dsh-llm-network-retry/host
 */

import { randomUUID } from 'node:crypto';

import { continueMessage, recoverable } from './resume.js';

/** Source tag recorded on plugin-authored user messages. */
const SOURCE_KIND = 'llm-network-retry';

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
        text: continueMessage({ turn: recovery.turn, unfinished: recovery.unfinished }),
      }),
    ]),
    source: Object.freeze({ kind: SOURCE_KIND, plugin: 'llm-network-retry' }),
  });
}

/**
 * Read one session's durable log and report whether it ended interrupted.
 *
 * Reads through persistence rather than a live agent, so a cold session — the
 * normal case right after a crash — can be inspected without activating it.
 * Returns `undefined` on any read failure: a session that cannot be opened is
 * not something this banner should claim to be able to fix.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - durable session identity.
 * @param signal - caller cancellation.
 * @returns the recovery summary, or `undefined`.
 */
export async function inspectSession(persistence, sessionId, signal) {
  if (persistence === undefined) return undefined;
  let handle;
  try {
    handle = await persistence.open(sessionId, 'read', { signal });
    const read = await handle.read(0, undefined, { signal });
    return recoverable(read.events);
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
 * @param options - live agent, persistence for the re-check, and cancellation.
 * @returns what was accepted, or why nothing was.
 */
export async function continueInterrupted({ agent, persistence, signal }) {
  if (agent === undefined || typeof agent.followup !== 'function') {
    return { ok: false, reason: 'agent-unavailable' };
  }
  const recovery = await inspectSession(persistence, agent.id, signal);
  if (recovery === undefined) return { ok: false, reason: 'nothing-to-recover' };
  agent.followup(continuationMessage(recovery));
  return { ok: true, turn: recovery.turn, unfinished: recovery.unfinishedNames };
}
