/** Coalesces redraw requests into frames; keeps frames coming only while something animates. */
export class FrameScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = Number.NEGATIVE_INFINITY;
  private animating = false;
  private disposed = false;

  constructor(private readonly draw: () => void, private readonly intervalMs = 16, private readonly now: () => number = () => performance.now()) {}

  /** Draw soon; many requests before the next frame produce one draw. */
  request(): void {
    if (this.timer || this.disposed) return;
    const wait = Math.max(0, this.last + this.intervalMs - this.now());
    this.timer = setTimeout(() => this.tick(), wait);
  }

  /** While on, a frame is drawn every interval, for pulses and moving knobs. */
  setAnimating(on: boolean): void {
    this.animating = on;
    if (on) this.request();
  }

  /** Draw now if a frame is pending; for tests and before exit. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    this.timer = undefined;
    if (this.disposed) return;
    this.last = this.now();
    this.draw();
    if (this.animating) this.request();
  }
}
