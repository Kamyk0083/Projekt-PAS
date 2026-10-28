import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getReservation } from "@/server/reservations";
import { AppError } from "@/server/errors";
import { ReservationScreen } from "@/components/reservation/ReservationScreen";

type Props = { params: Promise<{ reservationId: string }> };

export const metadata: Metadata = { title: "Twoja rezerwacja", robots: { index: false } };

export default async function ReservationPage({ params }: Props) {
  await connection();
  const { reservationId } = await params;
  try {
    const view = await getReservation(reservationId);
    return (
      <div className="page">
        <ReservationScreen initial={view} />
      </div>
    );
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
}
