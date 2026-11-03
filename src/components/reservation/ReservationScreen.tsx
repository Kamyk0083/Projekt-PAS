"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowCounterClockwise, CircleNotch, CreditCard, Info, LockSimple, Warning } from "@phosphor-icons/react";
import { api, ApiError } from "@/client/api";
import { usePolling } from "@/client/hooks";
import { formatCountdown, formatPrice, formatTime, relativeDayLabel } from "@/lib/format";
import { seatLabel } from "@/lib/hall";
import type { ReservationView } from "@/lib/types";
import { FlowSteps } from "@/components/FlowSteps";
import { Ticket } from "./Ticket";
import styles from "./ReservationScreen.module.css";

// "processing": klient wrócił ze Stripe'a po zapłacie, a webhook jeszcze nie dotarł.
type Phase = "held" | "processing" | "paid" | "expired";
export type Returned = "ok" | "cancelled" | null;

// Po tylu sekundach bez potwierdzenia mówimy wprost, że płatność się opóźnia (odpytujemy dalej).
const SLOW_PAYMENT_MS = 20_000;

function phaseOf(view: ReservationView, returned: Returned): Phase {
  if (view.status === "paid") return "paid";
  // Płatność po czasie może jeszcze przywrócić rezerwację, więc po powrocie z "ok" czekamy na webhook.
  if (returned === "ok" && !view.refund) return "processing";
  return view.status;
}

export function ReservationScreen({ initial, returned }: { initial: ReservationView; returned: Returned }) {
  const [view, setView] = useState(initial);
  const [phase, setPhase] = useState<Phase>(() => phaseOf(initial, returned));
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payingRef = useRef(false);
  payingRef.current = paying;

  // Zegar klienta może się różnić od serwera: liczymy przesunięcie raz, przy wczytaniu.
  const offsetRef = useRef(Date.parse(initial.serverTime) - Date.now());
  const expiresAt = Date.parse(view.expiresAt);
  const [remaining, setRemaining] = useState(() => expiresAt - (Date.now() + offsetRef.current));

  useEffect(() => {
    if (phase !== "held") return;
    const tick = () => {
      const left = expiresAt - (Date.now() + offsetRef.current);
      setRemaining(left);
      if (left <= 0 && !payingRef.current) setPhase("expired");
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, expiresAt]);

  // Po opłaceniu sprzątamy ?platnosc z adresu: odświeżenie strony pokaże po prostu bilet.
  useEffect(() => {
    if (phase === "paid" && returned) window.history.replaceState(null, "", `/rezerwacja/${view.reservationId}`);
  }, [phase, returned, view.reservationId]);

  // Powrót przyciskiem "wstecz" ze strony Stripe'a: przeglądarka może przywrócić stronę z pamięci
  // (bfcache) z przyciskiem w stanie "Przechodzę do płatności…". Odblokowujemy go i odświeżamy stan.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      setPaying(false);
      refresh().catch(() => undefined);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  });

  async function refresh(): Promise<ReservationView> {
    const next = await api<ReservationView>(`/api/reservations/${view.reservationId}`, { retries: 1, timeoutMs: 6000 });
    setView(next);
    if (next.status === "paid") setPhase("paid");
    else if (next.status === "expired" && (next.refund || phase !== "processing")) setPhase("expired");
    return next;
  }

  // Karta C: "płatność w toku…" sama zamienia się w bilet, gdy webhook oznaczy rezerwację jako opłaconą.
  usePolling(
    async () => {
      await refresh();
      return true;
    },
    1500,
    phase === "processing",
  );

  async function pay() {
    if (paying) return;
    setPaying(true);
    setError(null);
    try {
      // Serwer zwraca tę samą sesję przy ponowieniu, więc retry jest bezpieczny.
      const { url } = await api<{ url: string }>(`/api/reservations/${view.reservationId}/checkout`, {
        method: "POST",
        idempotent: true,
        // Klient czeka przed ekranem: jedno ponowienie, potem komunikat i przycisk.
        retries: 1,
      });
      // Zostawiamy stan "przechodzę…": za chwilę przeglądarka i tak opuści stronę.
      window.location.assign(url);
    } catch (err) {
      setPaying(false);
      if (err instanceof ApiError && err.code === "RESERVATION_EXPIRED") return setPhase("expired");
      if (err instanceof ApiError && err.code === "ALREADY_PAID") {
        await refresh().catch(() => undefined);
        return;
      }
      if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        return setError("Za dużo prób w krótkim czasie. Odczekaj kilka sekund i spróbuj ponownie.");
      }
      setError(err instanceof ApiError ? err.message : "Nie udało się otworzyć płatności. Spróbuj ponownie.");
    }
  }

  // Zmiana stanu: wejście animowane w CSS, treść nigdy nie czeka na JS.
  return (
    <div key={phase} className={styles.phase}>
      {phase !== "expired" && (
        <div className={phase === "paid" ? styles.stepsCentered : styles.steps}>
          <FlowSteps current={phase === "paid" ? 3 : 2} />
        </div>
      )}
      {phase === "held" && (
        <Held
          view={view}
          remaining={remaining}
          paying={paying}
          error={error}
          cancelled={returned === "cancelled"}
          onPay={pay}
        />
      )}
      {phase === "processing" && <Processing view={view} />}
      {phase === "expired" && <Expired view={view} />}
      {phase === "paid" && <Paid view={view} />}
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
      <div className={styles.total}>
        <dt>Do zapłaty</dt>
        <dd>{formatPrice(view.amount)}</dd>
      </div>
    </dl>
  );
}

type HeldProps = {
  view: ReservationView;
  remaining: number;
  paying: boolean;
  error: string | null;
  cancelled: boolean;
  onPay: () => void;
};

function Held({ view, remaining, paying, error, cancelled, onPay }: HeldProps) {
  const total = Math.max(1, Date.parse(view.expiresAt) - Date.parse(view.serverTime));
  const fraction = Math.min(1, Math.max(0, remaining / total));
  const urgent = remaining <= 60_000;
  const announced = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const price = formatPrice(view.amount);

  useEffect(() => {
    if (urgent && !announced.current && remaining > 0) {
      announced.current = true;
      setAnnouncement("Została mniej niż minuta na opłacenie biletu.");
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
            ? "Czas prawie minął. Zapłać teraz, inaczej fotel wróci do puli."
            : "Dla innych ten fotel jest teraz zajęty. Zapłać, zanim licznik dojdzie do zera."}
        </p>
        <p className="visually-hidden" aria-live="assertive">
          {announcement}
        </p>
      </section>

      <section className={styles.side} aria-label="Szczegóły rezerwacji">
        {cancelled && !error && (
          <p className={styles.notice} role="status">
            <Info size={18} weight="bold" aria-hidden />
            Płatność przerwana, nic nie pobraliśmy. Fotel nadal na Ciebie czeka, możesz zapłacić jeszcze raz.
          </p>
        )}
        <Summary view={view} />
        {error && (
          <p className={styles.error} role="alert">
            <Warning size={18} weight="bold" aria-hidden />
            {error}
          </p>
        )}
        <button className={`btn btn-primary ${styles.buy}`} onClick={onPay} disabled={paying} aria-busy={paying}>
          {paying ? (
            <>
              <CircleNotch size={18} weight="bold" className="spin" aria-hidden />
              Przechodzę do płatności…
            </>
          ) : error || cancelled ? (
            <>
              <ArrowCounterClockwise size={18} weight="bold" aria-hidden />
              Zapłać {price} jeszcze raz
            </>
          ) : (
            <>
              <CreditCard size={18} weight="bold" aria-hidden />
              Zapłać {price}
            </>
          )}
        </button>
        <div className={styles.note}>
          <p>
            <LockSimple size={14} weight="bold" aria-hidden />
            Płacisz kartą na bezpiecznej stronie Stripe. Kod biletu zobaczysz zaraz po zapłacie.
          </p>
          <p className={styles.testMode}>
            Tryb testowy, bez prawdziwych pieniędzy. Karta: <span className="mono">4242 4242 4242 4242</span>, dowolna
            przyszła data i CVC.
          </p>
        </div>
      </section>
    </div>
  );
}

function Processing({ view }: { view: ReservationView }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_PAYMENT_MS);
    return () => clearTimeout(id);
  }, []);

  return (
    <section className={styles.processing} aria-busy="true">
      <h1>
        Płatność w toku<span className={styles.dots} aria-hidden>…</span>
      </h1>
      <div className={styles.indeterminate} aria-hidden>
        <span />
      </div>
      <p role="status">
        {slow
          ? "Potwierdzenie od operatora płatności się opóźnia. Nie płać drugi raz: bilet pojawi się tutaj, gdy tylko dotrze."
          : `Czekamy na potwierdzenie płatności ${formatPrice(view.amount)}. Zwykle trwa to kilka sekund, bilet pojawi się tutaj sam.`}
      </p>
      <p className={styles.processingMeta}>
        {view.event.film}, {seatLabel(view.seatId)}
      </p>
    </section>
  );
}

function Expired({ view }: { view: ReservationView }) {
  if (view.refund) {
    return (
      <section className={styles.expired}>
        <h1>Płatność dotarła po czasie</h1>
        <p>
          Rezerwacja zdążyła wygasnąć, a ten fotel zajął już ktoś inny.{" "}
          {view.refund === "succeeded"
            ? `Zwróciliśmy ${formatPrice(view.amount)} na Twoją kartę.`
            : `Zlecamy zwrot ${formatPrice(view.amount)} na Twoją kartę.`}{" "}
          Bank zwykle księguje zwrot w ciągu kilku dni.
        </p>
        <div className={styles.actions}>
          <Link className="btn btn-primary" href={`/seanse/${view.eventId}`}>
            Wybierz inny fotel
          </Link>
          <Link className="btn btn-ghost" href="/">
            Repertuar
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section className={styles.expired}>
      <h1>Rezerwacja wygasła, fotel wrócił do puli</h1>
      <p>
        Minął czas na opłacenie biletu na {view.event.film}. {seatLabel(view.seatId)} może być nadal wolne, sprawdź plan
        sali.
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

// Maili nie wysyłamy naprawdę (dostawca w tle jest symulowany), więc ekran
// nie może tego obiecywać: jedynym nośnikiem biletu jest kod na tej stronie.
function Paid({ view }: { view: ReservationView }) {
  return (
    <div className={styles.purchased}>
      <div className={styles.purchasedHead}>
        <h1>Bilet jest Twój</h1>
        <p>
          Zapłacono {formatPrice(view.amount)}. Pokaż kod przy wejściu do sali.
        </p>
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
