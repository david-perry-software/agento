export interface RefreshEvent {
  reasons: string[];
}

export interface Disposable {
  dispose(): void;
}

export interface TimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RefreshScheduler implements Disposable {
  readonly debounceMs: number;
  private readonly listeners = new Set<(event: RefreshEvent) => void>();
  private readonly reasons: string[] = [];
  private timer: unknown;
  private disposed = false;

  constructor(configuredDebounceMs: number, private readonly timers: TimerApi = defaultTimers) {
    this.debounceMs = Math.max(3000, configuredDebounceMs);
  }

  onDidRefresh(listener: (event: RefreshEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  schedule(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.reasons.push(reason);
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
    }
    this.timer = this.timers.setTimeout(() => this.emit(), this.debounceMs);
  }

  refreshNow(reason: string): void {
    if (this.disposed) {
      return;
    }
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.reasons.push(reason);
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.reasons.length = 0;
    this.listeners.clear();
  }

  private emit(): void {
    this.timer = undefined;
    const event = { reasons: this.reasons.splice(0) };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}