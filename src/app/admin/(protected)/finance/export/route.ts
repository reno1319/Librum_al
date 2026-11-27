import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { maintenanceHttpResponse } from "@/lib/maintenance-response";
import {
  MAX_LEDGER_CSV_ROWS,
  buildStaffLedgerCsv,
  ledgerCsvFilename,
  ledgerCsvHeaders,
  type StaffLedgerCsvRow,
} from "@/lib/ledger-csv";

// CSV-1 (idea 35, ex1 b): Admin > Finance "Download CSV" -- every
// ledger move (sale, refund, payout, adjustment) for every author.
//
// requireStaff("finance.view") first (owner and admin only, the same
// gate as the Finance page), outside any try/catch since it redirects
// on its own. The read then uses the service-role client, exactly like
// site-totals.tsx: the ledger itself has a finance.view staff policy,
// but the author's name (profiles) and the book title (purchases ->
// books) have no staff read policy, so RLS alone cannot build the row.
//
// Data minimisation: the select below names every column it reads.
// Never the buyer (purchases.reader_id), never payment/payout/provider
// ids, never NID or tax numbers (those live in tables this never
// touches). Only the author's account display name, the book's title
// and pen name (cs1 a), and the ledger's own money columns.
//
// Any failed read is a plain error, never a partial file.

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;

const LEDGER_COLUMNS =
  "id, entry_type, amount_minor, currency, gross_amount_minor, librum_amount_minor, royalty_rate_bps, created_at," +
  " author:profiles!author_id(display_name), purchase:purchases!purchase_id(book:books!book_id(title, pen_name:pen_names!books_pen_name_id_fkey(name)))";

type LedgerReadRow = {
  id: string;
  entry_type: string;
  amount_minor: number;
  currency: string;
  gross_amount_minor: number | null;
  librum_amount_minor: number | null;
  royalty_rate_bps: number | null;
  created_at: string;
  author: { display_name: string | null } | null;
  purchase: { book: { title: string | null; pen_name: { name: string | null } | null } | null } | null;
};

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function failure(message: string, status: number): NextResponse {
  return new NextResponse(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
}

export async function GET() {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return maintenanceHttpResponse();
  }

  await requireStaff("finance.view");

  const admin = createAdminClient();
  const rows: StaffLedgerCsvRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("author_ledger_entries")
      .select(LEDGER_COLUMNS)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
      .returns<LedgerReadRow[]>();
    if (error) {
      console.error("FinanceExport: ledger read failed", { code: error.code ?? null });
      return failure("Couldn't build the file. Please try again.", 500);
    }
    const page = data ?? [];
    for (const row of page) {
      rows.push({
        entry_type: row.entry_type,
        amount_minor: row.amount_minor,
        currency: row.currency,
        gross_amount_minor: row.gross_amount_minor,
        librum_amount_minor: row.librum_amount_minor,
        royalty_rate_bps: row.royalty_rate_bps,
        created_at: row.created_at,
        author_name: row.author?.display_name ?? null,
        book_title: row.purchase?.book?.title ?? null,
        pen_name: row.purchase?.book?.pen_name?.name ?? null,
      });
    }
    if (rows.length > MAX_LEDGER_CSV_ROWS) {
      return failure("Too many ledger rows for one file.", 413);
    }
    if (page.length < PAGE_SIZE) break;
  }

  let body: string;
  try {
    body = buildStaffLedgerCsv(rows);
  } catch (error) {
    console.error("FinanceExport: building the CSV failed", { error: String(error) });
    return failure("Couldn't build the file. Please try again.", 500);
  }

  return new NextResponse(body, {
    status: 200,
    headers: ledgerCsvHeaders(ledgerCsvFilename("librum-te-gjitha-shitjet", new Date())),
  });
}
