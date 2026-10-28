import { AppError } from "./errors";

// Bulkhead (E05): osobne pule współbieżności, żeby zalew odczytów mapy sali
// nie zablokował rezerwacji i zakupów. Kolejka ma limit: gdy jest pełna,
// od razu odrzucamy żądanie (load shedding), zamiast kazać mu czekać.
export class Bulkhead {
  private active = 0;
  private queue: Array<{ start: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    readonly name: string,
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
    private readonly queueTimeoutMs: number,
  ) {}

  stats() {
    return { name: this.name, active: this.active, queued: this.queue.length, maxConcurrent: this.maxConcurrent };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) throw overloaded();
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: () => {
            clearTimeout(entry.timer);
            resolve();
          },
          timer: setTimeout(() => {
            this.queue = this.queue.filter((e) => e !== entry);
            reject(overloaded());
          }, this.queueTimeoutMs),
        };
        this.queue.push(entry);
      });
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next.start(); // slot przechodzi na następne żądanie, active bez zmian
      else this.active--;
    }
  }
}

function overloaded() {
  return new AppError(503, "OVERLOADED", "Mamy teraz bardzo duży ruch. Spróbuj ponownie za kilka sekund.", {
    retryable: true,
    retryAfterSec: 2,
  });
}

const g = globalThis as typeof globalThis & { __kinoPools?: Record<"read" | "write", Bulkhead> };

export const pools =
  g.__kinoPools ??
  (g.__kinoPools = {
    read: new Bulkhead("read", 64, 256, 2000),
    write: new Bulkhead("write", 24, 96, 4000),
  });
