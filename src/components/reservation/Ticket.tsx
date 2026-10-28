"use client";

import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { formatShortDay, formatTime } from "@/lib/format";
import { parseSeatId } from "@/lib/hall";
import type { ReservationView } from "@/lib/types";
import styles from "./Ticket.module.css";

// Karta C: bilet. Wysuwa się jak z drukarki kasowej (animacja CSS clip-path), bo to moment wydania biletu.
export function Ticket({ view }: { view: ReservationView }) {
  const [copied, setCopied] = useState(false);
  const seat = parseSeatId(view.seatId);
  const { event } = view;

  async function copy() {
    if (!view.code) return;
    try {
      await navigator.clipboard.writeText(view.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* brak dostępu do schowka: kod i tak jest widoczny */
    }
  }

  return (
    <article className={styles.ticket} aria-label={`Bilet na ${event.film}`}>
      <div className={styles.main}>
        <p className={styles.brand}>Kino Pasaż</p>
        <h2>{event.film}</h2>
        <p className={styles.when}>
          {formatShortDay(event.startsAt)}, <span className="mono">{formatTime(event.startsAt)}</span>
        </p>
        <dl className={styles.facts}>
          <div>
            <dt>Sala</dt>
            <dd>{event.hall.replace("Sala ", "")}</dd>
          </div>
          <div>
            <dt>Rząd</dt>
            <dd>{seat?.row}</dd>
          </div>
          <div>
            <dt>Miejsce</dt>
            <dd>{seat?.number}</dd>
          </div>
        </dl>
      </div>
      <div className={styles.stub}>
        <div>
          <p className={styles.codeLabel}>Kod biletu</p>
          <p className={`${styles.code} mono`}>{view.code}</p>
        </div>
        <button type="button" className={styles.copy} onClick={copy} aria-label="Skopiuj kod biletu">
          {copied ? <Check size={18} weight="bold" aria-hidden /> : <Copy size={18} aria-hidden />}
          <span>{copied ? "Skopiowano" : "Kopiuj"}</span>
        </button>
      </div>
    </article>
  );
}
