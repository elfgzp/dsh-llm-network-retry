/**
 * Boot-time scan: which stored sessions ended in a crash, and therefore have a
 * turn waiting to be continued.
 *
 * This exists because activation cannot be automatic. `agents.resume()` takes the
 * calling Context as the owner of the loaded agent and its session writer, so a
 * plugin that resumes sessions at boot holds them for its own lifetime — the
 * user's click on that session would then fight the plugin for write ownership.
 * Scanning is read-only and safe: `open(id, 'read')` never takes ownership and
 * works while another handle (or another process) owns the write side.
 *
 * So the division is: the scan never activates anything; it only tells the UI
 * which rows deserve a badge. Clicking a session opens it the normal way, and
 * the `agent/created` hook in ./index.js continues the interrupted turn there.
 *
 * @module dsh-llm-network-retry/scan
 */

import { recoverable } from './resume.js';

/**
 * Read one session's trailing turn without taking write ownership.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - stored session identity.
 * @param signal - caller cancellation.
 * @returns the recovery summary, or `undefined` when the session is unreadable
 *   or has nothing to continue.
 */
async function readOne(persistence, sessionId, signal) {
  let handle;
  try {
    handle = await persistence.open(sessionId, 'read', signal === undefined ? {} : { signal });
    const read = await handle.read(0, undefined, signal === undefined ? {} : { signal });
    return recoverable(read.events);
  } catch {
    // An unreadable session is not a crash: a torn log, a migration in
    // progress, or a session deleted between list() and open() all land here,
    // and none of them should produce a badge.
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
 * Scan every stored session for an interrupted trailing turn.
 *
 * Runs with bounded concurrency: a long history can hold thousands of sessions,
 * and opening all of them at once would spike file descriptors and starve the
 * boot path. Failures are per-session and never abort the scan.
 *
 * @param persistence - the `sessionPersistence` service, or `undefined`.
 * @param options - cancellation and concurrency.
 * @returns the sessions that ended in a crash, in list order.
 */
export async function scanInterrupted(persistence, options = {}) {
  if (persistence === undefined) return [];
  const { signal, concurrency = 4 } = options;

  let snapshots;
  try {
    snapshots = await persistence.list(signal === undefined ? {} : { signal });
  } catch {
    // No persistence, no scan. A profile without a session store has nothing
    // to recover and must not fail its boot over this.
    return [];
  }
  if (!Array.isArray(snapshots) || snapshots.length === 0) return [];

  const found = new Array(snapshots.length);
  let next = 0;

  /** Worker: pull indices until the list is exhausted. */
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= snapshots.length) return;
      if (signal?.aborted === true) return;
      const id = snapshots[index]?.id;
      if (typeof id !== 'string' || id === '') continue;
      found[index] = await readOne(persistence, id, signal);
      if (found[index] !== undefined) found[index] = { ...found[index], sessionId: id };
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, snapshots.length); i += 1) workers.push(worker());
  await Promise.all(workers);

  return found.filter((entry) => entry !== undefined);
}

/**
 * Reduce a scan to the payload the sidebar badge needs.
 *
 * A map keyed by session id, so the client can answer "does this row need a
 * badge?" in O(1) per render instead of scanning an array for every row.
 *
 * @param found - the result of {@link scanInterrupted}.
 * @returns `{ [sessionId]: { turn, unfinished } }`.
 */
export function toBadgeIndex(found) {
  const index = {};
  for (const entry of found ?? []) {
    index[entry.sessionId] = {
      turn: entry.turn,
      unfinished: entry.unfinishedNames ?? [],
    };
  }
  return index;
}
