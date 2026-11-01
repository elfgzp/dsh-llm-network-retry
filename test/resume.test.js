import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
