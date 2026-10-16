import { redirect } from "next/navigation";
import { uuid } from "@/lib/pok";
import { ResumeRedirect } from "./resume-redirect";

// R3-ADDR (P0 run 2026-10-16): a signed-out POK return sends the reader to
// /login, and login() is a Server Action. When a Server Action redirects to
// a route handler, the Next client router keeps the redirect target as the
// address while showing the page that handler redirected to (checked in
// next@16.3.4: server-action-reducer.js uses the x-action-redirect location
// as the new URL; action-handler.js follows the handler's redirect
// server-side). For /payments/pok/return that left the callback token in
// the address bar and history after sign-in. This page is the login target
// instead: it is a real page, so the address matches what is shown, and its
// only job is to hand over to the return route with a full navigation.
export default async function PokResumePage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string | string[]; token?: string | string[] }>;
}) {
  const query = await searchParams;
  const intent = uuid.safeParse(query.intent);
  const token = uuid.safeParse(query.token);
  if (!intent.success || !token.success) redirect("/library?error=Invalid+payment+return");

  const params = new URLSearchParams({ intent: intent.data, token: token.data });
  return <ResumeRedirect to={`/payments/pok/return?${params}`} />;
}
