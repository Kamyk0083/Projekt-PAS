"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/client/api";
import { usePolling } from "@/client/hooks";
import styles from "./SystemStatus.module.css";

type Status = {
  serverTime: string;
  reservationTtlSeconds: number;
  inFlight: number;
  pools: { name: string; active: number; queued: number; maxConcurrent: number }[];
  mailer: { state: "CLOSED" | "OPEN" | "HALF_OPEN"; recentRequests: number; recentFailures: number; retryAt: number | null };
  queue: {
    pending: number;
    processing: number;
    done: number;
    deadLetters: number;
    mailsSent: number;
    recentDeadLetters: { id: string; lastError: string; failedAt: string }[];
  };
  rateLimit: { enabled: boolean; capacity: number; refillPerSec: number };
};

const BREAKER_TEXT = {
  CLOSED: "Działa. Maile z biletami wychodzą normalnie.",
  OPEN: "Wstrzymany. Dostawca maili nie odpowiada, więc go nie wołamy i czekamy.",
  HALF_OPEN: "Próba. Puszczamy jedno zapytanie, żeby sprawdzić, czy dostawca wrócił.",
};

const POOL_NAMES: Record<string, string> = {
  read: "Odczyty (plan sali, repertuar)",
  write: "Zapisy (rezerwacje, zakupy)",
};

export function SystemStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/status", { retries: 0, timeoutMs: 4000 }));
      setOffline(false);
      return true;
    } catch {
      setOffline(true);
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(load, 2500);

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h1>Stan systemu</h1>
        <p>
          Jak kasa radzi sobie z awariami: kolejka maili z biletami, bezpiecznik dostawcy maili, pule zapytań i limit
          żądań. Dane odświeżają się same.
        </p>
        {offline && (
          <p className={styles.offline} role="status">
            Serwer nie odpowiada. Pokazujemy ostatnie znane dane.
          </p>
        )}
      </header>

      {!status ? (
        <div className={styles.skeleton} aria-hidden />
      ) : (
        <div className={styles.sections}>
          <section className={styles.breaker} data-state={status.mailer.state}>
            <h2>Dostawca maili</h2>
            <p className={`${styles.state} mono`}>{status.mailer.state}</p>
            <p>{BREAKER_TEXT[status.mailer.state]}</p>
            <p className={styles.small}>
              Ostatnie wywołania: {status.mailer.recentRequests}, w tym błędów: {status.mailer.recentFailures}.
            </p>
          </section>

          <section>
            <h2>Kolejka maili z biletami</h2>
            <dl className={styles.stats}>
              <Stat label="Czeka" value={status.queue.pending} />
              <Stat label="W trakcie" value={status.queue.processing} />
              <Stat label="Wysłane" value={status.queue.mailsSent} />
              <Stat label="Odłożone (DLQ)" value={status.queue.deadLetters} warn={status.queue.deadLetters > 0} />
            </dl>
            {status.queue.recentDeadLetters.length > 0 && (
              <ul className={styles.dlq}>
                {status.queue.recentDeadLetters.map((d) => (
                  <li key={d.id}>
                    <span className="mono">{d.id}</span>
                    <span>{d.lastError}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Pule zapytań</h2>
            <ul className={styles.rows}>
              {status.pools.map((p) => (
                <li key={p.name}>
                  <span>{POOL_NAMES[p.name] ?? p.name}</span>
                  <span className="mono">
                    {p.active}/{p.maxConcurrent}
                    {p.queued > 0 ? `, w kolejce ${p.queued}` : ""}
                  </span>
                </li>
              ))}
              <li>
                <span>Żądania w toku</span>
                <span className="mono">{status.inFlight}</span>
              </li>
            </ul>
          </section>

          <section>
            <h2>Zasady</h2>
            <ul className={styles.rows}>
              <li>
                <span>Czas trzymania fotela</span>
                <span className="mono">
                  {status.reservationTtlSeconds >= 60
                    ? `${Math.round(status.reservationTtlSeconds / 60)} min`
                    : `${status.reservationTtlSeconds} s`}
                </span>
              </li>
              <li>
                <span>Limit żądań na klienta</span>
                <span className="mono">
                  {status.rateLimit.enabled
                    ? `${status.rateLimit.capacity} naraz, +${status.rateLimit.refillPerSec}/s`
                    : "wyłączony"}
                </span>
              </li>
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div data-warn={warn ? "" : undefined}>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}
