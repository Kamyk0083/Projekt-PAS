import { route, json } from "@/server/http";
import { collections } from "@/server/db";
import { notFound } from "@/server/errors";
import { loyaltyBalance } from "@/server/loyalty";
import { parseReservationId } from "@/server/reservations";
import { maxPointsFor, spendablePoints } from "@/lib/loyalty";

type Ctx = { params: Promise<{ id: string }> };

// Kontrakt wewnętrzny (karta B): świeże saldo dla ekranu koszyka, bez ujawniania e-maila
// w przeglądarce. Osobny endpoint, bo GET /api/reservations/:id jest odpytywany w pętli
// i nie może dotykać Voucherify (limit 100 wywołań na godzinę).
export const GET = route<Ctx>({ pool: "read", rateLimitScope: "loyalty" }, async (_req, { params }) => {
  const { id } = await params;
  const { reservations } = await collections();
  const doc = await reservations.findOne({ _id: parseReservationId(id) }, { projection: { email: 1, amount: 1 } });
  if (!doc) throw notFound("rezerwacja");

  const balance = await loyaltyBalance(doc.email);
  return json({
    balance,
    maxPoints: maxPointsFor(doc.amount),
    spendable: spendablePoints(doc.amount, balance),
  });
});
