"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowCounterClockwise,
  CircleNotch,
  Coins,
  CreditCard,
  Info,
  LockSimple,
  Warning,
} from "@phosphor-icons/react";
import { api, ApiError } from "@/client/api";
import { usePolling } from "@/client/hooks";
import { formatCountdown, formatPrice, formatTime, relativeDayLabel } from "@/lib/format";
import { seatLabel } from "@/lib/hall";
import { formatPoints, pointsToGrosze, spendablePoints } from "@/lib/loyalty";
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

  // Karta B: punkty do wydania na ten bilet. Saldo z serwera przychodzi z cache'a,
  // więc po wejściu na ekran prosimy o świeże (osobny endpoint, nie ten odpytywany w pętli).
  const [balance, setBalance] = useState<number | null>(initial.loyalty.balance);
  const [points, setPoints] = useState(initial.pointsUsed);
  const [loyaltyDown, setLoyaltyDown] = useState(false);

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

  const refreshBalance = useCallback(async () => {
    try {
      const fresh = await api<{ balance: number }>(`/api/reservations/${initial.reservationId}/loyalty`, {
        retries: 1,
        timeoutMs: 7000,
      });
      setBalance(fresh.balance);
      setLoyaltyDown(false);
      return fresh.balance;
    } catch {
      // Łagodna degradacja: bez salda po prostu nie proponujemy punktów.
      setLoyaltyDown(true);
      return null;
    }
  }, [initial.reservationId]);

  useEffect(() => {
    if (phase === "held") refreshBalance();
  }, [phase, refreshBalance]);

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
        body: { points },
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
      if (err instanceof ApiError && err.code === "INSUFFICIENT_POINTS") {
        const fresh = await refreshBalance();
        if (fresh !== null) setPoints((p) => Math.min(p, spendablePoints(view.amount, fresh)));
        return setError(err.message);
      }
      if (err instanceof ApiError && (err.code === "LOYALTY_UNAVAILABLE" || err.code === "LOYALTY_BUSY")) {
        setLoyaltyDown(true);
        setPoints(0);
        return setError("Punkty są chwilowo niedostępne. Możesz zapłacić całą kwotę kartą.");
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
          balance={balance}
          loyaltyDown={loyaltyDown}
          points={points}
          onPoints={setPoints}
          onPay={pay}
        />
      )}
      {phase === "processing" && <Processing view={view} />}
      {phase === "expired" && <Expired view={view} />}
      {phase === "paid" && <Paid view={view} />}
    </div>
  );
}

function Summary({ view, points }: { view: ReservationView; points: number }) {
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
      {points > 0 && (
        <>
          <div>
            <dt>Cena biletu</dt>
            <dd>{formatPrice(view.amount)}</dd>
          </div>
          <div>
            <dt>Punkty</dt>
            <dd className={styles.discount}>
              −{formatPrice(pointsToGrosze(points))} <span>({formatPoints(points)})</span>
            </dd>
          </div>
        </>
      )}
      <div className={styles.total}>
        <dt>Do zapłaty kartą</dt>
        <dd>{formatPrice(view.amount - pointsToGrosze(points))}</dd>
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
  balance: number | null;
  loyaltyDown: boolean;
  points: number;
  onPoints: (points: number) => void;
  onPay: () => void;
};

function Held({
  view,
  remaining,
  paying,
  error,
  cancelled,
  balance,
  loyaltyDown,
  points,
  onPoints,
  onPay,
}: HeldProps) {
  const total = Math.max(1, Date.parse(view.expiresAt) - Date.parse(view.serverTime));
  const fraction = Math.min(1, Math.max(0, remaining / total));
  const urgent = remaining <= 60_000;
  const announced = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const price = formatPrice(view.amount - pointsToGrosze(points));

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
        <Summary view={view} points={points} />
        <PointsField
          amount={view.amount}
          maxPoints={view.loyalty.maxPoints}
          balance={balance}
          unavailable={loyaltyDown}
          points={points}
          disabled={paying}
          onPoints={onPoints}
        />
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

type PointsProps = {
  amount: number;
  maxPoints: number;
  balance: number | null;
  unavailable: boolean;
  points: number;
  disabled: boolean;
  onPoints: (points: number) => void;
};

// Karta B: „Użyj punktów”. Maksimum to mniejsze z połowy ceny i salda klienta,
// a cena nad przyciskiem zmienia się od razu. Reguły liczy ta sama funkcja co serwer.
function PointsField({ amount, maxPoints, balance, unavailable, points, disabled, onPoints }: PointsProps) {
  const id = useId();
  const spendable = balance === null ? 0 : spendablePoints(amount, balance);

  if (unavailable || balance === null) {
    return (
      <p className={styles.pointsOff} role="status">
        <Coins size={18} weight="bold" aria-hidden />
        Nie udało się sprawdzić Twoich punktów. Zapłać całość kartą, punkty za ten zakup i tak naliczymy.
      </p>
    );
  }

  if (spendable <= 0) {
    return (
      <p className={styles.pointsOff} role="status">
        <Coins size={18} weight="bold" aria-hidden />
        Masz {formatPoints(balance)}. Punktami zapłacisz, gdy uzbierasz co najmniej 100 (1 zł).
      </p>
    );
  }

  const set = (value: number) => onPoints(Math.max(0, Math.min(spendable, Math.round(value))));

  return (
    <section className={styles.points}>
      <div className={styles.pointsHead}>
        <label htmlFor={`${id}-points`}>
          <Coins size={18} weight="bold" aria-hidden />
          Użyj punktów
        </label>
        <button type="button" className={styles.pointsMax} onClick={() => set(spendable)} disabled={disabled}>
          Wykorzystaj {spendable}
        </button>
      </div>
      <div className={styles.pointsRow}>
        <input
          id={`${id}-points`}
          type="number"
          inputMode="numeric"
          min={0}
          max={spendable}
          step={100}
          value={points}
          disabled={disabled}
          onChange={(e) => set(Number(e.target.value))}
          aria-describedby={`${id}-points-hint`}
        />
        <span className={styles.pointsValue}>= {formatPrice(pointsToGrosze(points))}</span>
      </div>
      <input
        className={styles.pointsSlider}
        type="range"
        min={0}
        max={spendable}
        step={100}
        value={points}
        disabled={disabled}
        onChange={(e) => set(Number(e.target.value))}
        aria-label="Punkty do wykorzystania"
      />
      <p id={`${id}-points-hint`} className={styles.pointsHint}>
        Masz {formatPoints(balance)}. Przy tym bilecie zapłacisz punktami najwyżej {maxPoints} (
        {formatPrice(pointsToGrosze(maxPoints))}), czyli połowę ceny. 100 punktów to 1 zł.
      </p>
    </section>
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
          : `Czekamy na potwierdzenie płatności ${formatPrice(view.cardAmount)}. Zwykle trwa to kilka sekund, bilet pojawi się tutaj sam.`}
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
            ? `Zwróciliśmy ${formatPrice(view.cardAmount)} na Twoją kartę.`
            : `Zlecamy zwrot ${formatPrice(view.cardAmount)} na Twoją kartę.`}{" "}
          {view.pointsUsed > 0 && "Punkty wróciły na Twoje konto. "}
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

// Karta C: bilet i podsumowanie zakupu. Dokładnie to samo rozliczenie, co w mailu.
function Paid({ view }: { view: ReservationView }) {
  return (
    <div className={styles.purchased}>
      <div className={styles.purchasedHead}>
        <h1>Bilet jest Twój</h1>
        <p>
          {view.pointsUsed > 0
            ? `Zapłacono ${formatPrice(view.cardAmount)} kartą i ${formatPoints(view.pointsUsed)} z konta. Pokaż kod przy wejściu do sali.`
            : `Zapłacono ${formatPrice(view.cardAmount)}. Pokaż kod przy wejściu do sali.`}
        </p>
      </div>
      <Ticket view={view} />
      <dl className={styles.receipt}>
        <div>
          <dt>Cena biletu</dt>
          <dd>{formatPrice(view.amount)}</dd>
        </div>
        <div>
          <dt>Zapłacono kartą</dt>
          <dd>{formatPrice(view.cardAmount)}</dd>
        </div>
        {view.pointsUsed > 0 && (
          <div>
            <dt>Zapłacono punktami</dt>
            <dd>
              {formatPoints(view.pointsUsed)} <span>({formatPrice(view.pointsValue)})</span>
            </dd>
          </div>
        )}
        <div className={styles.earned}>
          <dt>Punkty za ten zakup</dt>
          <dd>+{view.pointsEarned}</dd>
        </div>
      </dl>
      <p className={styles.mail}>
        {view.emailStatus === "failed"
          ? "Maila z biletem nie udało się doręczyć (sprawdź adres). Zapisz kod albo zrób zrzut ekranu: ta strona zostaje pod tym samym adresem."
          : view.emailStatus === "sent"
            ? "Podsumowanie zakupu wysłaliśmy mailem. Ta strona zostaje pod tym samym adresem, więc możesz do niej wrócić."
            : "Mail z biletem i podsumowaniem jest w drodze. Kod działa od razu, niezależnie od maila."}
      </p>
      <Link className="btn btn-ghost" href="/">
        Wróć do repertuaru
      </Link>
    </div>
  );
}
