import { describe, it, expect, vi } from 'vitest';
import { AssistantTurnControl, WakeSuppression } from '../mobile/src/assistantTurnControl';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('one assistant reply per utterance', () => {
  it('coalesces three deliveries through request and speech, including a late replay', async () => {
    const control = new AssistantTurnControl();
    const speech = deferred();
    const work = vi.fn(async () => { await speech.promise; return 'spoken'; });
    const first = control.run('wake-1', work);
    const second = control.run('wake-1', work);
    const third = control.run('wake-1', work);
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    speech.resolve();
    await expect(first).resolves.toBe('spoken');
    await expect(control.run('wake-1', work)).resolves.toBe('spoken');
    expect(work).toHaveBeenCalledTimes(1);
    await control.run('wake-2', work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('ignores overlapping taps and admits a deliberate retry after failure', async () => {
    const control = new AssistantTurnControl();
    const pending = deferred();
    const first = control.run(undefined, async () => { await pending.promise; throw new Error('offline'); });
    const extra = vi.fn(async () => 'extra');
    await expect(control.run(undefined, extra)).resolves.toBeUndefined();
    expect(extra).not.toHaveBeenCalled();
    pending.resolve();
    await expect(first).rejects.toThrow('offline');
    await expect(control.run(undefined, extra)).resolves.toBe('extra');
  });
});

describe('wake suppression', () => {
  it('suspends before playback and stays suspended through overlapping capture', async () => {
    const changes: boolean[] = [];
    const suppression = new WakeSuppression(async (value) => { changes.push(value); });
    const audio = deferred();
    const capture = deferred();
    const one = suppression.run(async () => { expect(changes).toEqual([true]); await audio.promise; });
    const two = suppression.run(async () => { expect(changes).toEqual([true]); await capture.promise; });
    await Promise.resolve();
    audio.resolve();
    await one;
    expect(changes).toEqual([true]);
    capture.resolve();
    await two;
    expect(changes).toEqual([true, false]);
  });

  it('restores wake after failed playback', async () => {
    const changes: boolean[] = [];
    const suppression = new WakeSuppression(async (value) => { changes.push(value); });
    await expect(suppression.run(async () => { throw new Error('bad audio'); })).rejects.toThrow('bad audio');
    expect(changes).toEqual([true, false]);
  });
});
