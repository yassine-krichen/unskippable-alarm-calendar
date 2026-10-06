import type { Timers } from './scheduler';

interface FakeTimer {
  at: number;
  callback: () => void;
  interval: number | null;
}

/** Fake clock and timers for driving the scheduler without real time passing. */
export class FakeClock {
  constructor(public time: number) {}

  private nextId = 1;
  private readonly pending = new Map<number, FakeTimer>();
  /** Every delay ever passed to setTimeout, to check what the scheduler asked for. */
  readonly timeoutDelays: number[] = [];

  readonly timers: Timers = {
    setTimeout: (callback, ms) => {
      this.timeoutDelays.push(ms);
      return this.add(callback, ms, null);
    },
    clearTimeout: (handle) => this.pending.delete(handle as number),
    setInterval: (callback, ms) => this.add(callback, ms, ms),
    clearInterval: (handle) => this.pending.delete(handle as number),
  };

  now = (): Date => new Date(this.time);

  get timerCount(): number {
    return this.pending.size;
  }

  /** Forgets every pending one-shot timeout, as if the timer had drifted or never fired. */
  dropTimeouts(): void {
    for (const [id, timer] of this.pending) {
      if (timer.interval === null) this.pending.delete(id);
    }
  }

  dropIntervals(): void {
    for (const [id, timer] of this.pending) {
      if (timer.interval !== null) this.pending.delete(id);
    }
  }

  /** Runs timers in order up to the new time, like real time passing while awake. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.time = Math.max(this.time, timer.at);
      if (timer.interval === null) this.pending.delete(id);
      else timer.at += timer.interval;
      timer.callback();
    }
    this.time = target;
  }

  /** Moves the clock without running any timer, like the machine being asleep. */
  sleepFor(ms: number): void {
    this.time += ms;
  }

  private add(callback: () => void, ms: number, interval: number | null): number {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + ms, callback, interval });
    return id;
  }
}
