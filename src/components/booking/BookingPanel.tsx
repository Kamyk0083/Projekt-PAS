"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CircleNotch, Info, Warning, X } from "@phosphor-icons/react";
import { api, ApiError, newIdempotencyKey } from "@/client/api";
import { readStored, useMediaQuery, writeStored } from "@/client/hooks";
import { parseSeatId, totalSeats } from "@/lib/hall";
import { pluralSeats } from "@/lib/format";
import type { CinemaEvent } from "@/lib/types";
import styles from "./BookingPanel.module.css";

export type Notice = { tone: "info" | "warn"; text: string };

type Props = {
  event: CinemaEvent;
  selected: string | null;
  freeCount: number;
  ttlMinutes: number;
  notice: Notice | null;
  onClose: () => void;
  onConflict: (seat: string, message: string) => void;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate(name: string, email: string) {
  return {
    name: name.trim().length < 2 ? "Podaj imię, żebyśmy wiedzieli, na kogo trzymać fotel." : "",
    email: !EMAIL.test(email.trim()) ? "Podaj adres e-mail w formacie imie@domena.pl." : "",
  };
}

export function BookingPanel({ event, selected, freeCount, ttlMinutes, notice, onClose, onConflict }: Props) {
  const isDesktop = useMediaQuery("(min-width: 960px)", true);
  const reduce = useReducedMotion();

  return (
    <aside className={styles.panel} aria-label="Rezerwacja fotela">
      <div className={styles.intro}>
        {!selected && (
          <div className={styles.empty}>
            <h2>Wybierz fotel</h2>
            <p>
              Kliknij wolne miejsce na planie. Zatrzymamy je dla Ciebie przez {ttlMinutes} minut, a bilet kupisz na
              następnym ekranie.
            </p>
          </div>
        )}
        <Legend free={freeCount} total={totalSeats(event.layout)} />
        <AnimatePresence initial={false}>
          {notice && !selected && (
            <motion.p
              key={notice.text}
              className={styles.notice}
              data-tone={notice.tone}
              role="status"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {notice.tone === "warn" ? <Warning size={18} weight="bold" aria-hidden /> : <Info size={18} weight="bold" aria-hidden />}
              {notice.text}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {selected && (
          <motion.section
            key="sheet"
            className={styles.sheet}
            initial={reduce ? { opacity: 0 } : isDesktop ? { opacity: 0, y: 10 } : { y: "100%" }}
            animate={reduce ? { opacity: 1 } : isDesktop ? { opacity: 1, y: 0 } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : isDesktop ? { opacity: 0, y: 6 } : { y: "100%" }}
            transition={{ duration: isDesktop ? 0.24 : 0.42, ease: [0.32, 0.72, 0, 1] }}
            aria-labelledby="seat-heading"
          >
            <ReservationForm
              event={event}
              seat={selected}
              ttlMinutes={ttlMinutes}
              onClose={onClose}
              onConflict={onConflict}
            />
          </motion.section>
        )}
      </AnimatePresence>
    </aside>
  );
}

function Legend({ free, total }: { free: number; total: number }) {
  return (
    <div className={styles.legend}>
      <ul aria-label="Legenda">
        <li>
          <span className={styles.swatch} data-kind="free" aria-hidden /> Wolny
        </li>
        <li>
          <span className={styles.swatch} data-kind="taken" aria-hidden /> Zajęty
        </li>
        <li>
          <span className={styles.swatch} data-kind="selected" aria-hidden /> Twój wybór
        </li>
      </ul>
      <p className={styles.count}>
        <span className="mono">{free}</span> {pluralSeats(free)} z <span className="mono">{total}</span>
      </p>
    </div>
  );
}

type FormProps = {
  event: CinemaEvent;
  seat: string;
  ttlMinutes: number;
  onClose: () => void;
  onConflict: (seat: string, message: string) => void;
};

function ReservationForm({ event, seat, ttlMinutes, onClose, onConflict }: FormProps) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const formId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState({ name: false, email: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  // Jeden klucz idempotencji na jedną intencję (fotel + dane). Ponowienia go reużywają.
  const keyRef = useRef<{ intent: string; key: string } | null>(null);

  useEffect(() => {
    setName((v) => v || readStored("kino:name"));
    setEmail((v) => v || readStored("kino:email"));
  }, []);

  useEffect(() => setError(null), [seat]);

  const errors = validate(name, email);
  const parsed = parseSeatId(seat);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setTouched({ name: true, email: true });
    if (errors.name || errors.email) {
      (errors.name ? nameRef : emailRef).current?.focus();
      return;
    }

    const body = { eventId: event.id, seatId: seat, customerName: name.trim(), email: email.trim() };
    const intent = JSON.stringify(body);
    if (keyRef.current?.intent !== intent) keyRef.current = { intent, key: newIdempotencyKey() };

    setPending(true);
    setError(null);
    try {
      const res = await api<{ reservationId: string; expiresAt: string }>("/api/reservations", {
        method: "POST",
        body,
        idempotencyKey: keyRef.current.key,
      });
      writeStored("kino:name", body.customerName);
      writeStored("kino:email", body.email);
      router.push(`/rezerwacja/${res.reservationId}`);
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError && err.code === "SEAT_TAKEN") {
        onConflict(seat, `Fotel ${seat} ktoś zarezerwował chwilę przed Tobą. Wybierz inny.`);
        return;
      }
      if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        setError("Za dużo prób w krótkim czasie. Odczekaj kilka sekund i spróbuj ponownie.");
        return;
      }
      setError(err instanceof ApiError ? err.message : "Nie udało się zarezerwować fotela. Spróbuj ponownie.");
    }
  }

  return (
    <form id={formId} className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.formHead}>
        <div className={styles.seatTitle} aria-live="polite">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.h2
              key={seat}
              id="seat-heading"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
              transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            >
              Rząd {parsed?.row}, miejsce {parsed?.number}
            </motion.h2>
          </AnimatePresence>
          <p>{event.hall}</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Anuluj wybór fotela">
          <X size={18} weight="bold" aria-hidden />
        </button>
      </div>

      <div className={styles.field}>
        <label htmlFor={`${formId}-name`}>Imię</label>
        <input
          ref={nameRef}
          id={`${formId}-name`}
          name="customerName"
          autoComplete="given-name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          aria-invalid={touched.name && !!errors.name}
          aria-describedby={touched.name && errors.name ? `${formId}-name-err` : undefined}
          disabled={pending}
        />
        {touched.name && errors.name && (
          <p id={`${formId}-name-err`} className={styles.fieldError}>
            {errors.name}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor={`${formId}-email`}>E-mail</label>
        <input
          ref={emailRef}
          id={`${formId}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          maxLength={200}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
          aria-invalid={touched.email && !!errors.email}
          aria-describedby={`${formId}-email-hint${touched.email && errors.email ? ` ${formId}-email-err` : ""}`}
          disabled={pending}
        />
        <p id={`${formId}-email-hint`} className={styles.hint}>
          Na ten adres wyślemy bilet.
        </p>
        {touched.email && errors.email && (
          <p id={`${formId}-email-err`} className={styles.fieldError}>
            {errors.email}
          </p>
        )}
      </div>

      {error && (
        <p className={styles.formError} role="alert">
          <Warning size={18} weight="bold" aria-hidden />
          {error}
        </p>
      )}

      <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <CircleNotch size={18} weight="bold" className="spin" aria-hidden />
            Rezerwuję…
          </>
        ) : (
          `Zarezerwuj na ${ttlMinutes} min`
        )}
      </button>
    </form>
  );
}
