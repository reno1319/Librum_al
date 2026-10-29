import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createDiscountCode, toggleDiscountCode, deleteDiscountCode } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import {
  FIXED_ALL_DISCOUNT_FORM_TYPE,
  MAXIMUM_FIXED_DISCOUNT_ALL,
  MINIMUM_FIXED_DISCOUNT_ALL,
  describeDiscountCode,
} from "@/lib/discount-amount";
import { discountExpiryDisplayDate } from "@/lib/discount-code-limits";
import { groupAllDigits } from "@/lib/catalog-price";
import type { Book, DiscountCode } from "@/lib/types";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Zbritjet",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (discount_codes' discount columns are rendered below).
export const dynamic = "force-dynamic";

type DiscountCodeWithBook = DiscountCode & { books: Pick<Book, "title"> | null };

export default async function DiscountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders
  // discount_codes' discount columns (exhaustive route audit) -- checked
  // as the first statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { error: rawError, success: rawSuccess } = await searchParams;

  const error = pageErrorMessage(rawError);

  const success = pageSuccessMessage(rawSuccess);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: books } = await supabase
    .from("books")
    .select("id, title")
    .eq("author_id", user!.id)
    .order("title")
    .returns<Pick<Book, "id" | "title">[]>();

  const { data: codes } = await supabase
    .from("discount_codes")
    .select("*, books(title)")
    .eq("author_id", user!.id)
    .order("created_at", { ascending: false })
    .returns<DiscountCodeWithBook[]>();

  // DISCOUNT-LIMIT-1: uses per code (completed or open checkouts), from
  // a function that returns the caller's own codes only. If it fails --
  // or does not exist yet -- the list simply shows no counts.
  const { data: useData } = await supabase.rpc("discount_code_use_counts");
  const useRows = useData as { discount_code_id: string; uses: number }[] | null;
  const usesByCode = Array.isArray(useRows)
    ? new Map(useRows.map((row) => [row.discount_code_id, row.uses]))
    : null;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Kthehuni te paneli
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Kodet e zbritjes"
          description="Krijoni një kod promocional për një nga librat tuaj. Lexuesit e shkruajnë gjatë pagesës dhe marrin një zbritje në përqindje ose një shumë fikse në lekë."
        />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      {!books || books.length === 0 ? (
        <EmptyState
          className="mt-6"
          title="Ju duhet të paktën një libër para se të krijoni një kod zbritjeje."
        />
      ) : (
        <form
          action={createDiscountCode}
          className="mt-6 flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-sm"
        >
          <label className="flex flex-col gap-1 text-sm">
            Libri
            <select name="bookId" required defaultValue="" className={formControlClasses}>
              <option value="" disabled>
                Zgjidhni një libër
              </option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.title}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Kodi
            <input
              name="code"
              type="text"
              required
              placeholder="p.sh. NISJA20"
              className={`uppercase ${formControlClasses}`}
            />
          </label>

          {/* QA-FIX-4: stacked on phones. Side by side, the select's
              longest option plus the input's default width ran past a
              375px screen. min-w-0 lets each half shrink on wider ones. */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              Lloji i zbritjes
              <select name="type" required defaultValue="percent" className={formControlClasses}>
                <option value="percent">Zbritje në përqindje</option>
                {/* ALL-DISCOUNT-3: a fixed discount is whole lek, written
                    to amount_off_all. The old "amount" (USD) option is
                    gone, and its value is not reused. */}
                <option value={FIXED_ALL_DISCOUNT_FORM_TYPE}>Zbritje me shumë fikse (lekë)</option>
              </select>
            </label>

            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              Vlera
              {/* Text, not type="number": the whole-lek convention accepts
                  "250,00", which a number input refuses, and the server
                  parses the string without a float step either way. */}
              <input
                name="value"
                type="text"
                inputMode="decimal"
                required
                placeholder="p.sh. 20"
                className={formControlClasses}
              />
            </label>
          </div>
          <p className="-mt-2 text-sm text-muted">
            Përqindja: një numër i plotë nga 1 deri në 100. Shuma fikse: lekë të plota, nga{" "}
            {MINIMUM_FIXED_DISCOUNT_ALL} deri në {groupAllDigits(MAXIMUM_FIXED_DISCOUNT_ALL)} lekë. Një kod që do ta çonte
            librin nën çmimin minimal refuzohet gjatë pagesës.
          </p>

          <label className="flex flex-col gap-1 text-sm">
            Vlen deri më (opsionale)
            <input name="expiresAt" type="date" className={formControlClasses} />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Numri maksimal i përdorimeve (opsional)
            <input
              name="maxUses"
              type="text"
              inputMode="numeric"
              placeholder="Pa kufi"
              className={formControlClasses}
            />
          </label>

          <button type="submit" className={buttonClasses("primary", "md", "w-fit")}>
            Krijoni kodin
          </button>
        </form>
      )}

      <ul className="mt-8 flex flex-col gap-3">
        {(codes ?? []).map((code) => {
          const expired =
            !!code.expires_at && new Date(code.expires_at) < new Date();
          // ALL-DISCOUNT-3: one display for every stored shape. A legacy
          // amount_off_cents code is shown in USD with a notice, never
          // as lek; checkout refuses it (discount_not_applicable).
          const discount = describeDiscountCode(code);
          const uses = usesByCode ? (usesByCode.get(code.id) ?? 0) : null;

          return (
            <li
              key={code.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-sm"
            >
              <div>
                <p className="font-medium">
                  {code.code} <span className="text-muted">· {discount.label}</span>
                </p>
                {discount.kind === "legacy_usd" && (
                  <p className="text-xs font-medium text-amber-700">{discount.notice}</p>
                )}
                <p className="text-xs text-muted">
                  {code.books?.title}
                  {code.expires_at &&
                    ` · ${expired ? "Vlente deri më" : "Vlen deri më"} ${discountExpiryDisplayDate(code.expires_at)}`}
                  {uses !== null &&
                    (!code.max_uses ? ` · Përdorur: ${uses}` : ` · Përdorur: ${uses} nga ${code.max_uses}`)}
                  {!code.active && " · Çaktivizuar"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <form action={toggleDiscountCode.bind(null, code.id, code.active)}>
                  <button
                    type="submit"
                    className="focus-ring rounded-control border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
                  >
                    {code.active ? "Çaktivizoni" : "Aktivizoni"}
                  </button>
                </form>
                <form action={deleteDiscountCode.bind(null, code.id)}>
                  <button
                    type="submit"
                    className="focus-ring rounded-control border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                  >
                    Fshini
                  </button>
                </form>
              </div>
            </li>
          );
        })}
        {(codes ?? []).length === 0 && (
          <li>
            <EmptyState description="Ende nuk keni asnjë kod zbritjeje." />
          </li>
        )}
      </ul>
    </main>
  );
}
