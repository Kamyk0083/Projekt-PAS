// Circuit breaker (E04): po serii błędów przestajemy wołać zależność i od razu
// zwracamy błąd. Po resetTimeoutMs przepuszczamy jedno żądanie próbne (HALF_OPEN).
// Bezpiecznik jest wspólny dla wszystkich wywołań, bo pamięta historię błędów.

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  constructor(readonly retryAt: number) {
    super("Circuit breaker is OPEN");
  }
}

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private window: boolean[] = []; // ostatnie wyniki: true = błąd
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    readonly name: string,
    private readonly opts: {
      windowSize: number;
      minimumRequests: number;
      errorThresholdPercentage: number;
      resetTimeoutMs: number;
    },
  ) {}

  snapshot() {
    const failures = this.window.filter(Boolean).length;
    return {
      name: this.name,
      state: this.currentState(),
      recentRequests: this.window.length,
      recentFailures: failures,
      retryAt: this.state === "OPEN" ? this.openedAt + this.opts.resetTimeoutMs : null,
    };
  }

  private currentState(): BreakerState {
    if (this.state === "OPEN" && Date.now() - this.openedAt >= this.opts.resetTimeoutMs) {
      this.state = "HALF_OPEN";
    }
    return this.state;
  }

  canRequest(): boolean {
    const state = this.currentState();
    return state === "CLOSED" || (state === "HALF_OPEN" && !this.trialInFlight);
  }

  async fire<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState();
    if (state === "OPEN" || (state === "HALF_OPEN" && this.trialInFlight)) {
      throw new CircuitOpenError(this.openedAt + this.opts.resetTimeoutMs);
    }
    const isTrial = state === "HALF_OPEN";
    if (isTrial) this.trialInFlight = true;
    try {
      const value = await fn();
      this.record(false, isTrial);
      return value;
    } catch (err) {
      this.record(true, isTrial);
      throw err;
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }

  private record(failed: boolean, isTrial: boolean) {
    if (isTrial) {
      if (failed) this.trip();
      else this.reset();
      return;
    }
    this.window.push(failed);
    if (this.window.length > this.opts.windowSize) this.window.shift();
    const failures = this.window.filter(Boolean).length;
    if (
      this.window.length >= this.opts.minimumRequests &&
      (failures / this.window.length) * 100 >= this.opts.errorThresholdPercentage
    ) {
      this.trip();
    }
  }

  private trip() {
    this.state = "OPEN";
    this.openedAt = Date.now();
    this.window = [];
  }

  private reset() {
    this.state = "CLOSED";
    this.window = [];
  }
}
