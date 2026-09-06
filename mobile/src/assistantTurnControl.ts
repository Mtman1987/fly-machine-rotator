/** Coalesce a native event through its entire request and audio playback. */
export class AssistantTurnControl {
  private active: Promise<unknown> | undefined;
  private events = new Map<string, { at: number; promise: Promise<unknown> }>();

  run<T>(eventId: string | undefined, work: () => Promise<T>): Promise<T | undefined> {
    const now = Date.now();
    for (const [id, event] of this.events) {
      if (now - event.at > 300_000) this.events.delete(id);
    }
    const previous = eventId && this.events.get(eventId);
    if (previous) return previous.promise as Promise<T>;
    if (this.active) return Promise.resolve(undefined);
    const promise = Promise.resolve().then(work);
    this.active = promise;
    if (eventId) this.events.set(eventId, { at: now, promise });
    const cleanup = () => { if (this.active === promise) this.active = undefined; };
    void promise.then(cleanup, cleanup);
    return promise;
  }
}

/** Keep wake recognition off until all overlapping microphone/audio work ends. */
export class WakeSuppression {
  private leases = 0;
  private transition = Promise.resolve();
  constructor(private readonly setSuppressed: (value: boolean) => Promise<unknown>) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.leases += 1;
    if (this.leases === 1) {
      this.transition = this.transition.catch(() => {}).then(async () => { await this.setSuppressed(true); });
    }
    try {
      await this.transition;
      return await work();
    } finally {
      this.leases -= 1;
      if (this.leases === 0) {
        this.transition = this.transition.catch(() => {}).then(async () => { await this.setSuppressed(false); });
        await this.transition;
      }
    }
  }
}
