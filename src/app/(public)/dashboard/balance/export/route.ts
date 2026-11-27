import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import {
  MAX_LEDGER_CSV_ROWS,
  buildAuthorLedgerCsv,
  ledgerCsvFilename,
  ledgerCsvHeaders,
} from "@/lib/ledger-csv";
import type { AuthorFinancialActivityRow } from "@/lib/types";

// CSV-1 (idea 35, ex4 a): "Shkarko të gjitha (CSV)" on Bilanci -- the
// signed-in author's whole ledger, every move the page's "Lëvizjet e
// fundit" list shows, not only the latest 25.
//
// Reads ONLY list_author_financial_activity(), the same SECURITY
// DEFINER RPC the Bilanci page uses: it takes no author id and returns
// rows where author_id = auth.uid(), so an author can never get anyone
// else's rows through here, whatever they put in the URL (this route
// reads no query parameters at all). No buyer, no payment or payout
// identifiers -- the RPC never returns them.
//
// A route handler does not run the dashboard layout, so the sign-in
// check is done here. Any failed read sends the author back to Bilanci
// with a message; a half-built file is never served as if complete.

export const dynamic = "force-dynamic";

// The RPC's own page cap (it clamps p_limit to 1..100).
const RPC_PAGE_SIZE = 100;

const EXPORT_FAILED_MESSAGE = "Skedari nuk u krijua. Provoni përsëri.";
const EXPORT_TOO_BIG_MESSAGE = "Ka shumë lëvizje për një skedar. Na shkruani te support@librum.al.";

function backToBalance(request: Request, message: string): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/dashboard/balance?error=${encodeURIComponent(message)}`, request.url),
  );
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function GET(request: Request) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard/balance");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/dashboard/balance");
  }

  const rows: AuthorFinancialActivityRow[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    const { data, error } = await supabase.rpc("list_author_financial_activity", {
      p_limit: RPC_PAGE_SIZE,
      p_cursor_created_at: cursor?.createdAt ?? null,
      p_cursor_id: cursor?.id ?? null,
    });
    if (error) {
      console.error("BalanceExport: list_author_financial_activity RPC failed", { error });
      return backToBalance(request, EXPORT_FAILED_MESSAGE);
    }
    const page = (data ?? []) as AuthorFinancialActivityRow[];
    rows.push(...page);
    if (rows.length > MAX_LEDGER_CSV_ROWS) {
      return backToBalance(request, EXPORT_TOO_BIG_MESSAGE);
    }
    if (page.length < RPC_PAGE_SIZE) break;
    const last = page[page.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }

  let body: string;
  try {
    body = buildAuthorLedgerCsv(rows);
  } catch (error) {
    console.error("BalanceExport: building the CSV failed", { error });
    return backToBalance(request, EXPORT_FAILED_MESSAGE);
  }

  return new NextResponse(body, {
    status: 200,
    headers: ledgerCsvHeaders(ledgerCsvFilename("librum-bilanci", new Date())),
  });
}
