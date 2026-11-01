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
 *      it is also what the confirmation prompt must tell the model to verify
 *      rather than blindly redo.
 *
 * Everything here is derived from the durable log. Nothing here retries
 * anything: replaying a side-effecting tool call that was mid-flight when the
 * process died can duplicate `git push`, `rm`, `kubectl apply` and the like.
 *
 * @module dsh-llm-network-retry/resume
 */

/** Turn-end reason that means "the process died mid-turn". */
const INTERRUPTED = 'interrupted';

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
 * Build the confirmation message a user "continues" with.
 *
 * This is a user-role message, because that is the only thing that legitimately
 * opens a new turn; its text is written so the model cannot mistake the caveat
 * for optional advice. It names the unfinished tools instead of describing them
 * abstractly, so the model knows exactly what to verify first.
 *
 * @param options - the interrupted turn and the calls left open.
 * @returns the message text.
 */
export function continueMessage({ turn, unfinished }) {
  const names = (unfinished ?? []).map((call) => call.name);
  const distinct = [...new Set(names)];
  const toolNote =
    distinct.length === 0
      ? '没有工具调用停在中间。'
      : `以下工具调用在中断时尚未拿到结果，其副作用未知：${distinct.join('、')}。`;

  return [
    '（这条消息由「网络重试」插件在你点击「继续上次任务」后发送，不是你本人新写的指令。）',
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
 * Summarize one session for the confirmation banner.
 * @param events - committed session events, in seq order.
 * @returns what the banner needs to render, or `undefined` when there is nothing to recover.
 */
export function recoverable(events) {
  const turn = interruptedTurn(events);
  if (turn === undefined) return undefined;
  const unfinished = unfinishedToolCalls(events);
  return {
    turn,
    unfinished,
    unfinishedNames: [...new Set(unfinished.map((call) => call.name))],
  };
}
