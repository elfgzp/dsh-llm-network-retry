import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTINUATION_SOURCE,
  alreadyContinued,
  continueMessage,
  interruptedTurn,
  recoverable,
  unfinishedToolCalls,
} from '../lib/resume.js';

/** Build one session event with the fields the helpers read. */
let seq = 0;
function event(type, data = {}) {
  seq += 1;
  return { type, seq, time: 0, data };
}

/** Reset the shared counter so assertions about seq stay readable. */
function reset() {
  seq = 0;
}

describe('interruptedTurn', () => {
  it('reports nothing for an empty log', () => {
    assert.equal(interruptedTurn([]), undefined);
  });

  it('reports nothing for a log with no turn boundary', () => {
    reset();
    assert.equal(interruptedTurn([event('step/start', { turn: 1, step: 1 })]), undefined);
  });

  it('reports nothing when the trailing turn completed', () => {
    reset();
    const events = [
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ];
    assert.equal(interruptedTurn(events), undefined);
  });

  it('reports the interrupted turn number', () => {
    reset();
    const events = [
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', { turn: 2 }),
      event('turn/end', { turn: 2, reason: { kind: 'interrupted' } }),
    ];
    assert.equal(interruptedTurn(events), 2);
  });

  it('ignores an interrupted turn that the user already continued past', () => {
    reset();
    const events = [
      event('turn/start', { turn: 2 }),
      event('turn/end', { turn: 2, reason: { kind: 'interrupted' } }),
      // The user typed "继续" and that turn finished normally.
      event('turn/start', { turn: 3 }),
      event('turn/end', { turn: 3, reason: { kind: 'completed' } }),
    ];
    assert.equal(interruptedTurn(events), undefined, 'the interrupted turn is history now');
  });

  it('ignores a turn that the user cancelled themselves', () => {
    reset();
    const events = [
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ];
    assert.equal(interruptedTurn(events), undefined);
  });

  it('survives a malformed reason', () => {
    reset();
    assert.equal(interruptedTurn([event('turn/end', { turn: 1 })]), undefined);
  });
});

describe('unfinishedToolCalls', () => {
  it('lists a call that never got a result', () => {
    reset();
    const events = [
      event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
    ];
    assert.deepEqual(unfinishedToolCalls(events).map((c) => c.name), ['bash']);
  });

  it('drops a call that got its result', () => {
    reset();
    const events = [
      event('tool/call', { callId: 'c1', name: 'bash' }),
      event('tool/result', { message: { toolCallId: 'c1' } }),
    ];
    assert.deepEqual(unfinishedToolCalls(events), []);
  });

  it('matches by call id, not by position', () => {
    reset();
    const events = [
      event('tool/call', { callId: 'a', name: 'read' }),
      event('tool/call', { callId: 'b', name: 'write' }),
      // Results settle out of order: the second call finished first.
      event('tool/result', { message: { toolCallId: 'b' } }),
    ];
    assert.deepEqual(unfinishedToolCalls(events).map((c) => c.name), ['read']);
  });

  it('keeps start order', () => {
    reset();
    const events = [
      event('tool/call', { callId: 'z', name: 'third' }),
      event('tool/call', { callId: 'a', name: 'first' }),
    ];
    assert.deepEqual(unfinishedToolCalls(events).map((c) => c.name), ['third', 'first']);
  });

  it('uses the declared name over a missing one', () => {
    reset();
    const events = [event('tool/call', { callId: 'c1' })];
    assert.deepEqual(unfinishedToolCalls(events).map((c) => c.name), ['unknown']);
  });

  it('ignores results for calls it never saw start', () => {
    reset();
    assert.deepEqual(unfinishedToolCalls([event('tool/result', { message: { toolCallId: 'x' } })]), []);
  });

  it('tolerates a non-array input', () => {
    assert.deepEqual(unfinishedToolCalls(undefined), []);
  });
});

describe('continueMessage', () => {
  it('names the unfinished tools so the model knows what to verify', () => {
    const message = continueMessage({
      turn: 3,
      unfinished: [
        { name: 'bash' },
        { name: 'bash' },
        { name: 'write' },
      ],
    });
    assert.match(message, /第 3 轮/);
    assert.match(message, /bash、write/);
    // De-duplicated: one mention per distinct tool, not per call.
    assert.equal(message.match(/bash、bash/g), null);
  });

  it('says so plainly when no tool was mid-flight', () => {
    const message = continueMessage({ turn: 1, unfinished: [] });
    assert.match(message, /没有工具调用停在中间/);
  });

  it('marks the message as plugin-authored so the model does not think the user typed it', () => {
    const message = continueMessage({ turn: 1, unfinished: [] });
    assert.match(message, /不是你本人新写的指令/);
  });

  it('tells the model to verify state before retrying anything', () => {
    const message = continueMessage({ turn: 1, unfinished: [{ name: 'bash' }] });
    assert.match(message, /先核实当前实际状态/);
    assert.match(message, /不要盲目重放/);
    // Side-effecting operations are called out by name.
    assert.match(message, /推送|部署|删除/);
  });
});

describe('recoverable', () => {
  it('returns undefined when nothing was interrupted', () => {
    reset();
    assert.equal(recoverable([event('turn/end', { turn: 1, reason: { kind: 'completed' } })]), undefined);
  });

  it('returns the turn and the unfinished calls for the banner', () => {
    reset();
    const events = [
      event('turn/start', { turn: 2 }),
      event('tool/call', { callId: 'c1', name: 'bash' }),
      event('turn/end', { turn: 2, reason: { kind: 'interrupted' } }),
    ];
    const result = recoverable(events);
    assert.equal(result.turn, 2);
    assert.deepEqual(result.unfinishedNames, ['bash']);
    assert.equal(result.unfinished.length, 1);
  });
});

describe('alreadyContinued — the restart-loop guard', () => {
  it('reports nothing when the plugin never wrote a continuation', () => {
    reset();
    const events = [
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    ];
    assert.equal(alreadyContinued(events, 1), false);
  });

  it('finds a continuation this plugin wrote after the interrupted turn', () => {
    reset();
    const events = [
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
      event('user/message', { source: { kind: CONTINUATION_SOURCE } }),
      // That continuation crashed too, leaving another interrupted turn.
      event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    ];
    assert.equal(alreadyContinued(events, 1), true, 'a reproducing crash must not loop forever');
  });

  it('ignores a message from any other author', () => {
    reset();
    const events = [
      event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
      event('user/message', { source: { kind: 'user' } }),
    ];
    assert.equal(alreadyContinued(events, 1), false);
  });

  it('ignores a continuation written before the interrupted turn', () => {
    reset();
    const events = [
      event('user/message', { source: { kind: CONTINUATION_SOURCE } }),
      event('turn/end', { turn: 2, reason: { kind: 'interrupted' } }),
    ];
    assert.equal(alreadyContinued(events, 2), false, 'an older continuation does not cover a newer turn');
  });

  it('tolerates malformed input', () => {
    assert.equal(alreadyContinued(undefined, 1), false);
    assert.equal(alreadyContinued([null, {}], 1), false);
  });
});

describe('recoverable — automatic vs manual', () => {
  /** A log where the plugin already continued, then crashed again. */
  function loopingLog() {
    reset();
    return [
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
      event('user/message', { source: { kind: CONTINUATION_SOURCE } }),
      event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    ];
  }

  it('still offers a manual continuation when the automatic path is blocked', () => {
    const result = recoverable(loopingLog());
    assert.ok(result, 'the user may still choose to continue');
    assert.equal(result.alreadyContinued, true);
  });

  it('refuses the automatic path once it already ran', () => {
    assert.equal(
      recoverable(loopingLog(), { automatic: true }),
      undefined,
      'this is what makes a reproducible crash terminate instead of restart-looping',
    );
  });

  it('allows the automatic path on a first crash', () => {
    reset();
    const events = [
      event('turn/start', { turn: 5 }),
      event('turn/end', { turn: 5, reason: { kind: 'interrupted' } }),
    ];
    const result = recoverable(events, { automatic: true });
    assert.ok(result);
    assert.equal(result.turn, 5);
    assert.equal(result.alreadyContinued, false);
  });
});

describe('continueMessage — automatic wording', () => {
  it('tells the model the continuation was automatic', () => {
    const message = continueMessage({ turn: 2, unfinished: [], automatic: true });
    assert.match(message, /自动发送/);
    assert.match(message, /不是用户此刻主动要求继续/);
  });

  it('keeps the same safety instructions in both modes', () => {
    const manual = continueMessage({ turn: 2, unfinished: [{ name: 'bash' }] });
    const automatic = continueMessage({ turn: 2, unfinished: [{ name: 'bash' }], automatic: true });
    for (const message of [manual, automatic]) {
      assert.match(message, /先核实当前实际状态/);
      assert.match(message, /不要盲目重放/);
      assert.match(message, /bash/);
    }
  });
});
