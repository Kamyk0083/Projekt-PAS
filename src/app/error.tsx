"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import styles from "./status.module.css";

// Łagodna degradacja: zamiast pustej strony uczciwy komunikat i droga wyjścia.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className={`page ${styles.center}`}>
      <h1>Nie udało się wczytać tej strony</h1>
      <p>Nasz serwer chwilowo nie odpowiada. Twoje rezerwacje są bezpieczne, spróbuj za kilka sekund.</p>
      <button className="btn btn-primary" onClick={reset}>
        <ArrowCounterClockwise size={18} weight="bold" aria-hidden />
        Spróbuj ponownie
      </button>
    </div>
  );
}
