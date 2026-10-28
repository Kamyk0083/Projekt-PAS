"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowCounterClockwise, CircleNotch, Warning } from "@phosphor-icons/react";
import { api, ApiError } from "@/client/api";
import { formatCountdown, formatTime, relativeDayLabel } from "@/lib/format";
import { seatLabel } from "@/lib/hall";
import type { ReservationView } from "@/lib/types";
import { Ticket } from "./Ticket";
import styles from "./ReservationScreen.module.css";

type Phase = "held" | "purchased" | "expired";

export function ReservationScreen({ initial }: { initial: ReservationView }) {
  const [view, setView] = useState(initial);
  const [phase, setPhase] = useState<Phase>(initial.status);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buyingRef = useRef(false);
  buyingRef.current = buying;

  // Zegar klienta może się różnić od serwera: liczymy przesunięcie raz, przy wczytaniu.
  const offsetRef = useRef(Date.parse(initial.serverTime) - Date.now());
  const expiresAt = Date.parse(view.expiresAt);
  const [remaining, setRemaining] = useState(() => expiresAt - (Date.now() + offsetRef.current));

  useEffect(() => {
    if (phase !== "held") return;
    const tick = () => {
      const left = expiresAt - (Date.now() + offsetRef.current);
      setRemaining(left);
      if (left <= 0 && !buyingRef.current) setPhase("expired");
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, expiresAt]);

  async function buy() {
    if (buying) return;
    setBuying(true);
    setError(null);
    try {
      // Zakup jest idempotentny po stronie serwera, więc wolno go bezpiecznie ponawiać.
      const { code } = await api<{ code: string }>(`/api/reservations/${view.reservationId}/purchase`, {
        method: "POST",
        idempotent: true,
        retries: 4,
      });
      setView((v) => ({ ...v, status: "purchased", code }));
      setPhase("purchased");
    } catch (err) {
      if (err instanceof ApiError && err.code === "RESERVATION_EXPIRED") setPhase("expired");
      else setError(err instanceof ApiError ? err.message : "Nie udało się kupić biletu. Spróbuj ponownie.");
    } finally {
      setBuying(false);
    }
  }

  // Zmiana stanu (licznik -> bilet / wygasła): wejście animowane w CSS, treść nigdy nie czeka na JS.
  return (
    <div key={phase} className={styles.phase}>
      {phase === "held" && <Held view={view} remaining={remaining} buying={buying} error={error} onBuy={buy} />}
      {phase === "expired" && <Expired view={view} />}
      {phase === "purchased" && <Purchased view={view} />}
    </div>
  );
}

function Summary({ view }: { view: ReservationView }) {
  const { event } = view;
  return (
    <dl className={styles.summary}>
      <div>
        <dt>Film</dt>
        <dd>{event.film}</dd>
      </div>
      <div>
        <dt>Kiedy</dt>
        <dd>
          {relativeDayLabel(event.startsAt)}, <span className="mono">{formatTime(event.startsAt)}</span>
        </dd>
      </div>
      <div>
        <dt>Sala</dt>
        <dd>{event.hall}</dd>
      </div>
      <div>
        <dt>Miejsce</dt>
        <dd>{seatLabel(view.seatId)}</dd>
      </div>
      <div>
        <dt>Rezerwacja dla</dt>
        <dd>
          {view.customerName}, <span className={styles.email}>{view.emailMasked}</span>
        </dd>
      </div>
    </dl>
  );
}

type HeldProps = {
  view: ReservationView;
  remaining: number;
  buying: boolean;
  error: string | null;
  onBuy: () => void;
};

function Held({ view, remaining, buying, error, onBuy }: HeldProps) {
  const total = Math.max(1, Date.parse(view.expiresAt) - Date.parse(view.serverTime));
  const fraction = Math.min(1, Math.max(0, remaining / total));
  const urgent = remaining <= 60_000;
  const announced = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (urgent && !announced.current && remaining > 0) {
      announced.current = true;
      setAnnouncement("Została mniej niż minuta na zakup biletu.");
    }
  }, [urgent, remaining]);

  return (
    <div className={styles.grid}>
      <section className={styles.hero} data-urgent={urgent ? "" : undefined}>
        <h1>
          Trzymamy Twój fotel jeszcze
          <span className={`${styles.clock} mono`} role="timer" aria-label={`${formatCountdown(remaining)} minut`}>
            {formatCountdown(remaining)}
          </span>
        </h1>
        <div className={styles.progress} aria-hidden>
          <span style={{ transform: `scaleX(${fraction})` }} />
        </div>
        <p className={styles.lede}>
          {urgent
            ? "Czas prawie minął. Kup bilet teraz, inaczej fotel wróci do puli."
            : "Dla innych ten fotel jest teraz zajęty. Kup bilet, zanim licznik dojdzie do zera."}
        </p>
        <p className="visually-hidden" aria-live="assertive">
          {announcement}
        </p>
      </section>

      <section className={styles.side} aria-label="Szczegóły rezerwacji">
        <Summary view={view} />
        {error && (
          <p className={styles.error} role="alert">
            <Warning size={18} weight="bold" aria-hidden />
            {error}
          </p>
        )}
        <button className={`btn btn-primary ${styles.buy}`} onClick={onBuy} disabled={buying} aria-busy={buying}>
          {buying ? (
            <>
              <CircleNotch size={18} weight="bold" className="spin" aria-hidden />
              Kupuję…
            </>
          ) : error ? (
            <>
              <ArrowCounterClockwise size={18} weight="bold" aria-hidden />
              Spróbuj ponownie
            </>
          ) : (
            "Kupuję bilet"
          )}
        </button>
        <p className={styles.note}>Na tym etapie nie pobieramy płatności. Kod biletu dostaniesz od razu.</p>
      </section>
    </div>
  );
}

function Expired({ view }: { view: ReservationView }) {
  return (
    <section className={styles.expired}>
      <h1>Rezerwacja wygasła, fotel wrócił do puli</h1>
      <p>
        Minął czas na zakup biletu na {view.event.film}. {seatLabel(view.seatId)} może być nadal wolne, sprawdź plan sali.
      </p>
      <div className={styles.actions}>
        <Link className="btn btn-primary" href={`/seanse/${view.eventId}?fotel=${view.seatId}`}>
          Wybierz fotel ponownie
        </Link>
        <Link className="btn btn-ghost" href="/">
          Repertuar
        </Link>
      </div>
    </section>
  );
}

// Maili na razie nie wysyłamy naprawdę (dostawca w tle jest symulowany), więc ekran
// nie może tego obiecywać: jedynym nośnikiem biletu jest kod na tej stronie.
function Purchased({ view }: { view: ReservationView }) {
  return (
    <div className={styles.purchased}>
      <div className={styles.purchasedHead}>
        <h1>Bilet jest Twój</h1>
        <p>Pokaż kod przy wejściu do sali. Do zobaczenia w kinie.</p>
      </div>
      <Ticket view={view} />
      <p className={styles.mail}>
        Zapisz kod albo zrób zrzut ekranu. Ta strona zostaje pod tym samym adresem, więc możesz do niej wrócić.
      </p>
      <Link className="btn btn-ghost" href="/">
        Wróć do repertuaru
      </Link>
    </div>
  );
}
