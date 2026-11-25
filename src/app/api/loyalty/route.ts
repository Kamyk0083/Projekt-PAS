import { route, json } from "@/server/http";
import { badRequest } from "@/server/errors";
import { loyaltyBalance } from "@/server/loyalty";
import type { LoyaltyView } from "@/lib/types";

// A. GET /api/loyalty?email=... -> { email, points }: saldo punktów klienta.
// Nowy e-mail dostaje kartę lojalnościową w Voucherify i 1000 punktów powitalnych.
// Saldo prowadzi Voucherify (źródło prawdy), my tylko krótko je cache'ujemy.
export const GET = route({ pool: "read", rateLimitScope: "loyalty" }, async (req) => {
  // Adresy testowe Resenda mają etykietę po "+" (delivered+jan@resend.dev), a "+" w query
  // string to zakodowana spacja. W e-mailu spacja nie jest dozwolona, więc zamiana jest
  // bezpieczna i pozwala wołać endpoint również bez kodowania (curl, pasek przeglądarki).
  const raw = (new URL(req.url).searchParams.get("email") ?? "").trim().toLowerCase().replace(/ /g, "+");
  if (!raw) throw badRequest("Podaj parametr email.");
  if (raw.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)) throw badRequest("Podaj poprawny adres e-mail.");

  const points = await loyaltyBalance(raw);
  return json({ email: raw, points } satisfies LoyaltyView);
});
