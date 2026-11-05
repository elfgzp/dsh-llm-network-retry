/**
 * Pure crash-recovery helpers — no Host services, no timers.
 *
 * A DSH process that is killed, crashes, or closes past its timeout leaves a
 * session log whose tail turn never closed. On the next start,
 * `dsh-agent-loop` repairs that log by appending synthetic closers, producing
 * `turn/end` with `reason.kind === 'interrupted'`. The Chat UI renders that as
 * 「任务已停止 / DSH 进程在本轮完成前退出…未完成的工具调用结果未知」.
 *
 * This module answers two questions about such a log:
 *
 *   1. Is the *trailing* turn the interrupted one? A user who already typed
 *      "继续" produces a later, normally-closed turn — offering to continue
 *      again would be noise.
 *   2. What exactly is missing? Which tool calls were recorded as started but
 *      never got a result. That list is what makes automatic replay unsafe, so
 *      it is also what the continuation prompt must tell the model to verify
 *      rather than blindly redo.
 *   3. Has this plugin already continued it? An automatic continuation that
 *      itself crashes must not continue again on the next boot, or a session
 *      that reliably kills the process becomes an unbounded restart loop.
 *
 * Everything here is derived from the durable log. Nothing here retries
 * anything: replaying a side-effecting tool call that was mid-flight when the
 * process died can duplicate `git push`, `rm`, `kubectl apply` and the like.
 *
 * @module dsh-llm-network-retry/resume
 */

/** Turn-end reason that means "the process died mid-turn". */
const INTERRUPTED = 'interrupted';

/** The `source.kind` this plugin stamps on the continuation messages it writes. */
export const CONTINUATION_SOURCE = 'llm-network-retry';

/**
 * Find the last `turn/end` event in a log.
 * @param events - committed session events, in seq order.
 * @returns the trailing turn-end event, or `undefined` for a log with no turn.
 */
function lastTurnEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') return events[index];
  }
  return undefined;
}

/**
 * Whether a session's trailing turn was interrupted by a process death.
 *
 * Only the LAST turn counts. If the user already continued (or the turn was
 * later closed any other way), the interrupted turn is history, not a task that
 * still needs recovering.
 *
 * @param events - committed session events, in seq order.
 * @returns the interrupted turn number, or `undefined` when nothing needs recovering.
 */
export function interruptedTurn(events) {
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const end = lastTurnEnd(events);
  if (end === undefined) return undefined;
  if (end.data?.reason?.kind !== INTERRUPTED) return undefined;
  const turn = end.data?.turn;
  return typeof turn === 'number' ? turn : 0;
}

/**
 * List the tool calls that were recorded as started but never got a durable
 * result before the interruption.
 *
 * A `tool/result` may arrive in any order, so this matches by call id rather
 * than by position. Calls left open are exactly the operations whose outcome
 * the harness cannot vouch for (`ToolCallRecovery` says the same thing to the
 * model when it repairs the log).
 *
 * @param events - committed session events, in seq order.
 * @returns the unfinished calls, in the order they started.
 */
export function unfinishedToolCalls(events) {
  if (!Array.isArray(events)) return [];
  /** @type {Map<string, { callId: string, name: string, seq: number }>} */
  const started = new Map();
  const finished = new Set();
  for (const event of events) {
    if (event?.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '');
      if (callId === '') continue;
      started.set(callId, {
        callId,
        name: String(event.data?.name ?? 'unknown'),
        seq: Number(event.seq ?? 0),
      });
    } else if (event?.type === 'tool/result') {
      const callId = String(event.data?.message?.toolCallId ?? event.data?.callId ?? '');
      if (callId !== '') finished.add(callId);
    }
  }
  return [...started.values()].filter((call) => !finished.has(call.callId));
}

/**
 * Build the message a continuation writes.
 *
 * This is a user-role message, because that is the only thing that legitimately
 * opens a new turn. Its text is written so the model cannot mistake the caveat
 * for optional advice: it names the unfinished tools instead of describing them
 * abstractly, and — when the continuation was automatic — says so in the first
 * line, because the model has to know that no human chose to resume right now.
 *
 * @param options - the interrupted turn, the calls left open, and whether this
 *   continuation was automatic.
 * @returns the message text.
 */
export function continueMessage({ turn, unfinished, automatic = false }) {
  const names = (unfinished ?? []).map((call) => call.name);
  const distinct = [...new Set(names)];
  const toolNote =
    distinct.length === 0
      ? '没有工具调用停在中间。'
      : `以下工具调用在中断时尚未拿到结果，其副作用未知：${distinct.join('、')}。`;
  const origin = automatic
    ? '（这条消息由「网络重试」插件在 DSH 重启后自动发送，不是用户本人新写的指令，也不是用户此刻主动要求继续。）'
    : '（这条消息由「网络重试」插件在用户点击「继续上次任务」后发送，不是你本人新写的指令。）';

  return [
    origin,
    `上一次运行在第 ${turn} 轮完成前被中断（DSH 进程退出），本轮已中止。${toolNote}`,
    '请按这个顺序继续：',
    '1. 先核实当前实际状态（文件、Git 工作区、远端、相关服务），不要假设中断前的操作已经完成；',
    '2. 只对只读或幂等的操作直接重试；',
    '3. 对可能有副作用的操作（写文件、删除、提交或推送代码、发布、部署等），先确认它是否已经生效，再决定是否重做；',
    '4. 状态不清楚时先问我，不要盲目重放。',
    '核实完成后，接着完成原来那件事，并告诉我中断期间可能有哪些状态变化。',
  ].join('\n');
}

/**
 * Whether this plugin already wrote a continuation message for the trailing
 * interrupted turn.
 *
 * The guard against a restart loop: if the automatic continuation is itself
 * killed, the next boot sees the same interrupted turn AND the message this
 * plugin previously injected. Continuing again would make a reproducible crash
 * loop forever, so the plugin stops and leaves the decision to the user.
 *
 * @param events - committed session events, in seq order.
 * @param turn - the interrupted turn being considered.
 * @returns whether a plugin-authored continuation already exists after that turn.
 */
export function alreadyContinued(events, turn) {
  if (!Array.isArray(events)) return false;
  let sawInterrupt = false;
  for (const event of events) {
    if (event?.type === 'turn/end' && event.data?.turn === turn) sawInterrupt = true;
    if (!sawInterrupt) continue;
    const source = event?.type === 'user/message' ? event.data?.source : undefined;
    if (source?.kind === CONTINUATION_SOURCE) return true;
  }
  return false;
}

/**
 * Summarize one session for the continuation banner or the automatic path.
 * @param events - committed session events, in seq order.
 * @param options - `automatic` marks the caller as the boot-time path, which
 *   refuses a turn this plugin already continued.
 * @returns what the caller needs, or `undefined` when there is nothing to recover.
 */
export function recoverable(events, options = {}) {
  const turn = interruptedTurn(events);
  if (turn === undefined) return undefined;
  const unfinished = unfinishedToolCalls(events);
  const continued = alreadyContinued(events, turn);
  if (options.automatic === true && continued) return undefined;
  return {
    turn,
    unfinished,
    unfinishedNames: [...new Set(unfinished.map((call) => call.name))],
    alreadyContinued: continued,
  };
}
