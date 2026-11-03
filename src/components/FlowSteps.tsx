import { Check } from "@phosphor-icons/react/dist/ssr";
import styles from "./FlowSteps.module.css";

// Trzy etapy zakupu. Od etapu II jest ich więcej niż kliknięcie "kup", więc pokazujemy, gdzie klient jest.
const STEPS = ["Fotel", "Płatność", "Bilet"] as const;

export function FlowSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className={styles.steps} aria-label="Etapy zakupu biletu">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "next";
        return (
          <li key={label} data-state={state} aria-current={n === current ? "step" : undefined}>
            <span className={styles.dot} aria-hidden>
              {state === "done" ? <Check size={11} weight="bold" /> : n}
            </span>
            <span className={styles.label}>{label}</span>
            {state === "done" && <span className="visually-hidden"> (zrobione)</span>}
          </li>
        );
      })}
    </ol>
  );
}
