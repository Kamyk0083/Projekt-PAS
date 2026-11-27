"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/client/api";
import { readStored, usePolling, writeStored } from "@/client/hooks";
import { isSeatInHall, totalSeats } from "@/lib/hall";
import type { CinemaEvent, EventDetails } from "@/lib/types";
import { SeatMap } from "./SeatMap";
import { BookingPanel, type Notice } from "./BookingPanel";
import { WaitlistPanel } from "./WaitlistPanel";
import styles from "./HallBooking.module.css";

type Props = {
  event: CinemaEvent;
  initialTaken: string[];
  initialSeat: string | null;
  initialSoldOut: boolean;
  initialWaitlistId: string | null; // ?kolejka=<waitlistId>: link do własnego miejsca w kolejce
  ttlMinutes: number;
};

const WAITLIST_ID = /^[0-9a-f-]{36}$/i;
const storageKey = (eventId: string) => `kino:waitlist:${eventId}`;

export function HallBooking({ event, initialTaken, initialSeat, initialSoldOut, initialWaitlistId, ttlMinutes }: Props) {
  const [taken, setTaken] = useState(() => new Set(initialTaken));
  const [selected, setSelected] = useState<string | null>(() =>
    initialSeat && isSeatInHall(initialSeat, event.layout) && !initialTaken.includes(initialSeat) ? initialSeat : null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stale, setStale] = useState(false);
  // Etap IV: wyprzedany seans i wpis tej przeglądarki na liście oczekujących.
  const [soldOut, setSoldOut] = useState(initialSoldOut);
  const [waitlistId, setWaitlistId] = useState<string | null>(initialWaitlistId);

  useEffect(() => {
    if (initialWaitlistId) return writeStored(storageKey(event.id), initialWaitlistId);
    const stored = readStored(storageKey(event.id));
    if (WAITLIST_ID.test(stored)) setWaitlistId(stored);
  }, [event.id, initialWaitlistId]);

  const changeWaitlist = useCallback(
    (id: string | null) => {
      setWaitlistId(id);
      writeStored(storageKey(event.id), id ?? "");
      // Adres z ?kolejka= to link do własnego miejsca w kolejce (np. na innym urządzeniu).
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("kolejka", id);
      else url.searchParams.delete("kolejka");
      window.history.replaceState(null, "", url);
    },
    [event.id],
  );

  const syncUrl = (seat: string | null) => {
    const url = new URL(window.location.href);
    if (seat) url.searchParams.set("fotel", seat);
    else url.searchParams.delete("fotel");
    window.history.replaceState(null, "", url);
  };

  const select = useCallback((seat: string | null) => {
    setSelected(seat);
    setNotice(null);
    syncUrl(seat);
  }, []);

  const applyTaken = useCallback((next: string[]) => {
    const set = new Set(next);
    setTaken(set);
    setSelected((current) => {
      if (current && set.has(current)) {
        setNotice({ tone: "warn", text: `Ktoś właśnie zajął fotel ${current}. Wybierz inny.` });
        syncUrl(null);
        return null;
      }
      return current;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<EventDetails>(`/api/events/${encodeURIComponent(event.id)}`, {
        retries: 1,
        timeoutMs: 5000,
      });
      applyTaken(data.takenSeats);
      setSoldOut(data.soldOut);
      setStale(false);
      return true;
    } catch {
      // Łagodna degradacja: zostawiamy ostatni znany plan i uczciwie o tym mówimy.
      setStale(true);
      return false;
    }
  }, [event.id, applyTaken]);

  // Inni klienci też rezerwują: odświeżamy plan co kilka sekund.
  usePolling(refresh, 5000);

  const freeCount = totalSeats(event.layout) - taken.size;
  const takenForMap = useMemo(() => taken, [taken]);

  return (
    <div className={styles.layout} data-has-selection={selected ? "" : undefined}>
      <section className={styles.mapCol} aria-label="Plan sali">
        <SeatMap
          layout={event.layout}
          taken={takenForMap}
          selected={selected}
          onSelect={(seat) => select(seat === selected ? null : seat)}
          onTakenAttempt={(seat) => setNotice({ tone: "info", text: `Fotel ${seat} jest zajęty.` })}
        />
        {stale && (
          <p className={styles.stale} role="status">
            Nie możemy odświeżyć planu. Pokazujemy ostatni znany stan, ponawiamy w tle.
          </p>
        )}
      </section>

      <BookingPanel
        event={event}
        selected={selected}
        freeCount={freeCount}
        ttlMinutes={ttlMinutes}
        notice={notice}
        waitlist={
          soldOut || waitlistId ? (
            <WaitlistPanel
              event={event}
              waitlistId={waitlistId}
              soldOut={soldOut}
              ttlMinutes={ttlMinutes}
              onChange={changeWaitlist}
              onSeatsFreed={() => void refresh()}
            />
          ) : null
        }
        onClose={() => select(null)}
        onConflict={(seat, text) => {
          setTaken((prev) => new Set(prev).add(seat));
          setSelected(null);
          syncUrl(null);
          setNotice({ tone: "warn", text });
          void refresh();
        }}
      />
    </div>
  );
}
