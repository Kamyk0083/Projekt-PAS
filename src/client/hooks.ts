"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

// Odpytywanie z przerwą na ukrytą kartę i wykładniczym zwolnieniem po błędach.
export function usePolling(task: () => Promise<boolean>, intervalMs: number, enabled = true) {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let stopped = false;

    const schedule = () => {
      const delay = Math.min(intervalMs * 2 ** failures, 30_000);
      timer = setTimeout(run, delay);
    };
    const run = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") return schedule();
      const ok = await taskRef.current().catch(() => false);
      failures = ok ? 0 : Math.min(failures + 1, 4);
      schedule();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        run();
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);
}

export function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* prywatne okno lub zablokowany storage: wygoda, nie wymóg */
  }
}
