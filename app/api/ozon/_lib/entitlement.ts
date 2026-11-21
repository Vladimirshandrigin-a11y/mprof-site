import { NextResponse } from "next/server";
import type { AuthSuccess } from "../../cloud/_lib/auth";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const FREE_LIMIT = 1;

export function ozonEntitlementDenied(
  reason: string,
  used?: number,
  allowance?: number,
): NextResponse {
  return NextResponse.json(
    {
      error: "API-расчёт доступен на тарифе «Безлимит» (449 ₽/мес) или как первый бесплатный пробный расчёт. Оформите тариф, чтобы продолжить.",
      code: "limit_reached",
      consume: { ok: false, reason, used, allowance },
    },
    { status: 402, headers: NO_STORE },
  );
}

/** Read-only check before contacting Ozon. Saving still checks and consumes atomically. */
export async function requireOzonEntitlement({ admin, userId }: AuthSuccess): Promise<NextResponse | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("plan, premium_until, calculations_used")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: "Не удалось проверить доступ к Ozon API. Попробуйте ещё раз.", code: "entitlement_check_failed" },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!data) return ozonEntitlementDenied("profile_not_found");

  const unlimited = data.plan === "unlimited" && Date.parse(data.premium_until ?? "") > Date.now();
  const used = data.calculations_used ?? 0;
  return unlimited || used < FREE_LIMIT ? null : ozonEntitlementDenied("limit_reached", used, FREE_LIMIT);
}
