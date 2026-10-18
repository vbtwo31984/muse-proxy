/** Fixed-window counter keyed by an arbitrary string. In-memory; resets on restart, which is fine for abuse throttling. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records a hit; returns false if the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      this.sweep(now);
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }

  /** True if the key is currently over its limit, without recording a hit. */
  blocked(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    return !!w && now - w.start < this.windowMs && w.count >= this.limit;
  }

  private sweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
