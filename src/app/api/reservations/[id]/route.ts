import { route, json } from "@/server/http";
import { getReservation } from "@/server/reservations";

type Ctx = { params: Promise<{ id: string }> };

// Kontrakt wewnętrzny: stan rezerwacji dla ekranu z licznikiem i ekranu biletu.
export const GET = route<Ctx>({ pool: "read" }, async (_req, { params }) => {
  const { id } = await params;
  return json(await getReservation(id));
});
