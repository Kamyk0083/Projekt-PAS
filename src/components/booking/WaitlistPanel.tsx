"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Bell, BellRinging, CheckCircle, CircleNotch, Hourglass, Info, UsersThree, Warning } from "@phosphor-icons/react";
import { api, ApiError } from "@/client/api";
import { readStored, usePolling, writeStored } from "@/client/hooks";
import { formatCountdown, formatPrice, formatTime } from "@/lib/format";
import { seatLabel } from "@/lib/hall";
import type { CinemaEvent, WaitlistJoin, WaitlistView } from "@/lib/types";
import form from "./BookingPanel.module.css";
import styles from "./WaitlistPanel.module.css";

// Karta A (etap IV): lista oczekujących na wyprzedanym seansie.
// "Powiadom mnie" -> zapis -> miejsce w kolejce i "Wypisz mnie". Gdy zwolni się fotel,
// ta sama karta pokazuje ofertę (karta B) z licznikiem i przyciskiem do zapłaty.

type Props = {
  event: CinemaEvent;
  waitlistId: string | null;
  soldOut: boolean;
  ttlMinutes: number;
  onChange: (waitlistId: string | null) => void;
  onSeatsFreed: () => void;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ACTIVE = new Set(["waiting", "offered"]);

function pluralPeople(n: number): string {
  if (n === 1) return "osoba";
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? "osoby" : "osób";
}

export function WaitlistPanel({ event, waitlistId, soldOut, ttlMinutes, onChange, onSeatsFreed }: Props) {
  const [view, setView] = useState<WaitlistView | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);

  const load = useCallback(async () => {
    if (!waitlistId) return true;
    try {
      const next = await api<WaitlistView>(`/api/waitlist/${waitlistId}`, { retries: 1, timeoutMs: 6000 });
      offsetRef.current = Date.parse(next.serverTime) - Date.now();
      setView(next);
      return true;
    } catch (err) {
      // Wpis z innej bazy albo literówka w linku: zaczynamy od zera.
      if (err instanceof ApiError && err.status === 404) onChange(null);
      return false;
    }
  }, [waitlistId, onChange]);

  useEffect(() => {
    setView(null);
    setError(null);
    if (waitlistId) void load();
  }, [waitlistId, load]);

  // Strona osoby z listy odpytuje stan co kilka sekund: tak widzi ofertę, zanim dojdzie mail.
  usePolling(load, 4000, Boolean(waitlistId) && (!view || ACTIVE.has(view.status)));

  async function leave() {
    if (!waitlistId || leaving) return;
    setLeaving(true);
    setError(null);
    try {
      // DELETE jest idempotentny po stronie serwera, więc ponowienie jest bezpieczne.
      await api(`/api/waitlist/${waitlistId}`, { method: "DELETE", idempotent: true, retries: 2 });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Nie udało się wypisać. Spróbuj ponownie.");
    } finally {
      setLeaving(false);
    }
  }

  if (!waitlistId) {
    return <JoinForm event={event} ttlMinutes={ttlMinutes} onJoined={onChange} onSeatsFreed={onSeatsFreed} />;
  }

  if (!view) {
    return (
      <div className={styles.card} aria-busy="true">
        <p className={styles.kicker}>
          <CircleNotch size={16} weight="bold" className="spin" aria-hidden />
          Sprawdzamy Twoje miejsce w kolejce…
        </p>
      </div>
    );
  }

  const leaveButton = (label: string) => (
    <button type="button" className={`btn btn-ghost ${styles.wide}`} onClick={leave} disabled={leaving} aria-busy={leaving}>
      {leaving ? <CircleNotch size={18} weight="bold" className="spin" aria-hidden /> : null}
      {leaving ? "Wypisuję…" : label}
    </button>
  );
  const errorLine = error && (
    <p className={form.formError} role="alert">
      <Warning size={18} weight="bold" aria-hidden />
      {error}
    </p>
  );

  switch (view.status) {
    case "waiting":
      return (
        <div className={styles.card}>
          <p className={styles.kicker}>
            <UsersThree size={16} weight="bold" aria-hidden />
            Lista oczekujących
          </p>
          <p className={styles.position} aria-live="polite">
            <span className={styles.positionLabel}>Twoje miejsce w kolejce</span>
            <span className={`${styles.positionNumber} mono`}>{view.position}</span>
          </p>
          <p className={styles.text}>
            {view.position === 1
              ? "Jesteś następną osobą w kolejce."
              : `Przed Tobą ${view.position - 1 === 1 ? "jest" : "są"} ${view.position - 1} ${pluralPeople(view.position - 1)}.`}{" "}
            Gdy ktoś nie zapłaci za rezerwację, miejsce będzie czekać na Ciebie {ttlMinutes} min, a link do zapłaty
            wyślemy na <span className={styles.email}>{view.emailMasked}</span>.
          </p>
          <p className={form.hint}>Ta strona odświeża się sama i pokaże miejsce, gdy tylko się zwolni.</p>
          {errorLine}
          {leaveButton("Wypisz mnie")}
        </div>
      );

    case "offered":
      return (
        <Offer view={view} event={event} offset={offsetRef.current} onExpired={load}>
          {errorLine}
          {leaveButton("Nie chcę tego miejsca, wypisz mnie")}
        </Offer>
      );

    case "done":
      return (
        <div className={styles.card} data-tone="success">
          <p className={styles.kicker}>
            <CheckCircle size={16} weight="bold" aria-hidden />
            Bilet kupiony
          </p>
          <p className={styles.text}>
            Miejsce z listy oczekujących jest Twoje{view.seatId ? `: ${seatLabel(view.seatId)}` : ""}.
          </p>
          {view.reservationId && (
            <Link href={`/rezerwacja/${view.reservationId}`} className={`btn btn-primary ${styles.wide}`}>
              Pokaż bilet
              <ArrowRight size={18} weight="bold" aria-hidden />
            </Link>
          )}
          {!soldOut && (
            <button type="button" className={`btn btn-ghost ${styles.wide}`} onClick={() => onChange(null)}>
              Kup kolejny bilet
            </button>
          )}
        </div>
      );

    case "missed":
    case "left":
      return (
        <div className={styles.card}>
          <p className={styles.kicker}>
            <Info size={16} weight="bold" aria-hidden />
            {view.status === "left" ? "Wypisano Cię z listy" : "Miejsce przeszło dalej"}
          </p>
          <p className={styles.text}>
            {view.status === "left"
              ? "Nie dostaniesz już maila o wolnym miejscu na ten seans."
              : view.missedReason === "undelivered"
                ? `Mail z linkiem do zapłaty nie doszedł na ${view.emailMasked}, więc miejsce przeszło na następną osobę z listy (albo wróciło do puli, gdy nikt nie czekał).`
                : "Czas na zapłatę minął, więc miejsce przeszło na następną osobę z listy (albo wróciło do puli, gdy nikt nie czekał)."}
          </p>
          <button type="button" className={`btn btn-ghost ${styles.wide}`} onClick={() => onChange(null)}>
            {soldOut ? "Zapisz się ponownie" : "Wybierz fotel na planie"}
          </button>
        </div>
      );
  }
}

function Offer({
  view,
  event,
  offset,
  onExpired,
  children,
}: {
  view: WaitlistView;
  event: CinemaEvent;
  offset: number;
  onExpired: () => Promise<boolean>;
  children: React.ReactNode;
}) {
  const until = view.offerExpiresAt ? Date.parse(view.offerExpiresAt) : Date.now();
  const [remaining, setRemaining] = useState(() => until - (Date.now() + offset));
  const checked = useRef(false);

  useEffect(() => {
    checked.current = false;
    const tick = () => {
      const left = until - (Date.now() + offset);
      setRemaining(left);
      // Koniec czasu: pytamy serwer o stan (missed albo kupione), zamiast zgadywać.
      if (left <= 0 && !checked.current) {
        checked.current = true;
        void onExpired();
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [until, offset, onExpired]);

  const urgent = remaining <= 60_000;
  return (
    <div className={styles.card} data-tone="offer" data-urgent={urgent ? "" : undefined}>
      <p className={styles.kicker}>
        <BellRinging size={16} weight="bold" aria-hidden />
        Zwolniło się miejsce dla Ciebie
      </p>
      <h2 className={styles.seat}>{view.seatId ? seatLabel(view.seatId) : "Twoje miejsce"}</h2>
      <p className={styles.countdown}>
        <Hourglass size={18} weight="bold" aria-hidden />
        <span>
          Czeka jeszcze{" "}
          <span className="mono" role="timer">
            {formatCountdown(remaining)}
          </span>
          {view.offerExpiresAt ? <>, do {formatTime(view.offerExpiresAt)}</> : null}
        </span>
      </p>
      <p className={styles.text}>
        Link do zapłaty wysłaliśmy też na <span className={styles.email}>{view.emailMasked}</span>. Możesz zapłacić
        częściowo punktami.
      </p>
      {view.reservationId && (
        <Link href={`/rezerwacja/${view.reservationId}`} className={`btn btn-primary ${styles.wide}`}>
          Zapłać {formatPrice(event.price)}
          <ArrowRight size={18} weight="bold" aria-hidden />
        </Link>
      )}
      {children}
    </div>
  );
}

function JoinForm({
  event,
  ttlMinutes,
  onJoined,
  onSeatsFreed,
}: {
  event: CinemaEvent;
  ttlMinutes: number;
  onJoined: (waitlistId: string) => void;
  onSeatsFreed: () => void;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName((v) => v || readStored("kino:name"));
    setEmail((v) => v || readStored("kino:email"));
    nameRef.current?.focus();
  }, [open]);

  const errors = {
    name: name.trim().length < 2 ? "Podaj imię, żebyśmy wiedzieli, do kogo piszemy." : "",
    email: !EMAIL.test(email.trim()) ? "Podaj adres e-mail w formacie imie@domena.pl." : "",
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setTouched(true);
    if (errors.name || errors.email) return;
    setPending(true);
    setError(null);
    const body = { customerName: name.trim(), email: email.trim() };
    try {
      // Ponowienie jest bezpieczne: ten sam e-mail dostaje od serwera ten sam wpis.
      const res = await api<WaitlistJoin>(`/api/events/${encodeURIComponent(event.id)}/waitlist`, {
        method: "POST",
        body,
        idempotent: true,
      });
      writeStored("kino:name", body.customerName);
      writeStored("kino:email", body.email);
      onJoined(res.waitlistId);
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError && err.code === "NOT_SOLD_OUT") {
        setError("Właśnie zwolniło się miejsce. Wybierz fotel na planie sali.");
        onSeatsFreed();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Nie udało się zapisać na listę. Spróbuj ponownie.");
    }
  }

  return (
    <div className={styles.card}>
      <p className={styles.kicker}>
        <UsersThree size={16} weight="bold" aria-hidden />
        Seans wyprzedany
      </p>
      <h2 className={styles.title}>Wszystkie miejsca są zajęte</h2>
      <p className={styles.text}>
        Część foteli może być tylko zarezerwowana. Jeśli ktoś nie zapłaci w {ttlMinutes} min, miejsce dostanie pierwsza
        osoba z listy oczekujących, a my wyślemy jej mail z linkiem do zapłaty.
      </p>

      {!open ? (
        <button type="button" className={`btn btn-primary ${styles.wide}`} onClick={() => setOpen(true)}>
          <Bell size={18} weight="bold" aria-hidden />
          Powiadom mnie
        </button>
      ) : (
        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={form.field}>
            <label htmlFor={`${formId}-name`}>Imię</label>
            <input
              ref={nameRef}
              id={`${formId}-name`}
              autoComplete="given-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={touched && !!errors.name}
              disabled={pending}
            />
            {touched && errors.name && <p className={form.fieldError}>{errors.name}</p>}
          </div>
          <div className={form.field}>
            <label htmlFor={`${formId}-email`}>E-mail</label>
            <input
              id={`${formId}-email`}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              maxLength={200}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={touched && !!errors.email}
              aria-describedby={`${formId}-email-hint`}
              disabled={pending}
            />
            <p id={`${formId}-email-hint`} className={form.hint}>
              Na ten adres wyślemy link, gdy zwolni się miejsce.
            </p>
            {touched && errors.email && <p className={form.fieldError}>{errors.email}</p>}
          </div>
          {error && (
            <p className={form.formError} role="alert">
              <Warning size={18} weight="bold" aria-hidden />
              {error}
            </p>
          )}
          <button type="submit" className={`btn btn-primary ${styles.wide}`} disabled={pending} aria-busy={pending}>
            {pending ? (
              <>
                <CircleNotch size={18} weight="bold" className="spin" aria-hidden />
                Zapisuję…
              </>
            ) : (
              "Zapisz mnie na listę"
            )}
          </button>
        </form>
      )}
    </div>
  );
}
