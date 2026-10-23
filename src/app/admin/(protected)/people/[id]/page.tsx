import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { loadStaffDisplayNames } from "@/lib/staff-display-names";
import { Alert } from "@/components/ui/alert";
import type { Metadata } from "next";
import { bookStateLabel } from "../../books/book-admin-logic";
import {
  isUuid,
  personBankLabel,
  personSalesLabel,
  personStatusLabel,
  personTypeLabel,
  type PersonRow,
} from "../people-logic";

export const metadata: Metadata = {
  title: "Person",
};

// Reads the account's live state on every request.
export const dynamic = "force-dynamic";

// PEOPLE-1 (10a): one account -- email, type, joined, status, the
// mockup's counts, their pen names, their books (each opening its admin
// book page) and the suspension history, newest first, with the reason
// staff gave (6a: staff only, never shown to the person).
// requireStaff("people.view") is the gate; the summary comes from
// admin_list_people() on the staff member's own session (it checks
// people.view itself), and the pen names, books and history are read
// with the service-role client after that gate, because a staff session
// cannot see another author's drafts (as /admin/books/[id] does). The
// staff names in the history come from staff_profile_display_names, so
// no profiles row is read here.
// Suspend and Lift arrive with PEOPLE-2.

type PenNameRow = { id: string; name: string; is_default: boolean };
type BookRow = { id: string; title: string; status: string; pen: { name: string } | null };
type SuspensionRow = {
  id: string;
  reason: string;
  book_ids: string[];
  bundle_ids: string[];
  suspended_by: string | null;
  suspended_at: string;
  lifted_at: string | null;
  lifted_by: string | null;
};

const BOOKS_SHOWN = 100;
const LOAD_ERROR = "Couldn't load everything about this person. Please try again.";
const SECTION_CLASSES = "rounded-card border border-border bg-surface p-5";
const SECTION_HEADING_CLASSES = "mb-2.5 font-serif text-[1.375rem] font-bold text-primary";

function unpublishedLabel(row: SuspensionRow): string {
  const books = row.book_ids.length;
  const bundles = row.bundle_ids.length;
  const parts = [books === 1 ? "1 book" : `${books} books`];
  if (bundles > 0) parts.push(bundles === 1 ? "1 bundle" : `${bundles} bundles`);
  return `Took ${parts.join(" and ")} out of the Bookstore`;
}

export default async function AdminPersonPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff("people.view");

  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const { data: summaryData, error: summaryError } = await supabase.rpc("admin_list_people", {
    p_user_id: id,
    p_limit: 1,
  });
  if (summaryError) {
    console.error("admin person: summary read failed", { error: summaryError });
    return (
      <main className="mx-auto flex w-full min-w-0 max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
        <Alert variant="error">{LOAD_ERROR}</Alert>
      </main>
    );
  }
  const person = ((summaryData ?? []) as PersonRow[])[0];
  if (!person) notFound();

  const admin = createAdminClient();
  const [pensResult, booksResult, suspensionsResult] = await Promise.all([
    admin
      .from("pen_names")
      .select("id, name, is_default")
      .eq("author_id", id)
      .order("is_default", { ascending: false })
      .order("name", { ascending: true })
      .returns<PenNameRow[]>(),
    admin
      .from("books")
      .select("id, title, status, pen:pen_names(name)")
      .eq("author_id", id)
      .order("created_at", { ascending: false })
      .limit(BOOKS_SHOWN)
      .returns<BookRow[]>(),
    admin
      .from("account_suspensions")
      .select("id, reason, book_ids, bundle_ids, suspended_by, suspended_at, lifted_at, lifted_by")
      .eq("user_id", id)
      .order("suspended_at", { ascending: false })
      .returns<SuspensionRow[]>(),
  ]);

  const books = booksResult.data ?? [];
  const bookIds = books.map((b) => b.id);
  const suspensions = suspensionsResult.data ?? [];
  const staffIds = Array.from(
    new Set(suspensions.flatMap((s) => [s.suspended_by, s.lifted_by]).filter((v): v is string => typeof v === "string")),
  );

  const [reviewsResult, takedownsResult, staffNames] = await Promise.all([
    bookIds.length > 0
      ? admin.from("book_reviews").select("book_id").eq("status", "pending").in("book_id", bookIds).returns<{ book_id: string }[]>()
      : Promise.resolve({ data: [] as { book_id: string }[], error: null }),
    bookIds.length > 0
      ? admin.from("book_takedowns").select("book_id").is("lifted_at", null).in("book_id", bookIds).returns<{ book_id: string }[]>()
      : Promise.resolve({ data: [] as { book_id: string }[], error: null }),
    loadStaffDisplayNames(supabase, staffIds),
  ]);

  const loadFailed = Boolean(
    pensResult.error || booksResult.error || suspensionsResult.error || reviewsResult.error || takedownsResult.error,
  );
  if (loadFailed) {
    console.error("admin person: detail read failed", {
      pens: pensResult.error,
      books: booksResult.error,
      suspensions: suspensionsResult.error,
      reviews: reviewsResult.error,
      takedowns: takedownsResult.error,
    });
  }

  const inReview = new Set((reviewsResult.data ?? []).map((r) => r.book_id));
  const takenDown = new Set((takedownsResult.data ?? []).map((t) => t.book_id));
  const staffName = (staffId: string | null) => (staffId ? (staffNames.get(staffId) ?? "A former staff member") : "A former staff member");
  const status = personStatusLabel(person);
  const pens = pensResult.data ?? [];

  const facts: [string, string][] = [
    ["Email", person.email ?? "No email"],
    ["Type", personTypeLabel(person)],
    ["Joined", formatTimestampAsDate(person.joined_at)],
    ["Status", status],
    ["Paid sales", personSalesLabel(person)],
    ["Bank account", personBankLabel(person)],
    ["Books bought", String(person.owned_books)],
  ];

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <div>
        <Link href="/admin/people" className="focus-ring inline-flex min-h-11 items-center text-sm underline">
          ← People
        </Link>
        <p className="mt-2 text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">
          {personTypeLabel(person)} · {status}
        </p>
        <h1 className="mt-1 font-serif text-[2rem] font-bold break-words text-primary md:text-[2.5rem]">{person.display_name}</h1>
      </div>

      {loadFailed && <Alert variant="error">{LOAD_ERROR}</Alert>}

      {person.is_staff && (
        <p className="rounded-card border border-border bg-surface p-4 text-sm text-muted">
          This is a staff account. Staff can&apos;t be suspended; remove them from Staff first.
        </p>
      )}

      <section aria-labelledby="person-facts" className={SECTION_CLASSES}>
        <h2 id="person-facts" className={SECTION_HEADING_CLASSES}>
          Account
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="font-semibold text-muted">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="person-pen-names" className={SECTION_CLASSES}>
        <h2 id="person-pen-names" className={SECTION_HEADING_CLASSES}>
          Pen names
        </h2>
        {pens.length === 0 ? (
          <p className="text-sm text-muted">No pen names.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {pens.map((pen) => (
              <li key={pen.id} className="break-words">
                {pen.name}
                {pen.is_default && <span className="text-muted"> (default)</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="person-books" className={SECTION_CLASSES}>
        <h2 id="person-books" className={SECTION_HEADING_CLASSES}>
          Books
        </h2>
        {books.length === 0 ? (
          <p className="text-sm text-muted">No books.</p>
        ) : (
          <ul className="flex flex-col">
            {books.map((book) => (
              <li key={book.id} className="border-t border-border first:border-t-0">
                <Link
                  href={`/admin/books/${book.id}`}
                  className="focus-ring flex min-h-11 flex-col gap-1 py-2 hover:bg-surface-hover sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold break-words text-primary">{book.title}</span>
                    <span className="block text-sm text-muted">{book.pen?.name ?? "Unknown pen name"}</span>
                  </span>
                  <span className="text-sm">{bookStateLabel(book.status, takenDown.has(book.id), inReview.has(book.id))}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {books.length === BOOKS_SHOWN && <p className="mt-2 text-sm text-muted">Showing the newest {BOOKS_SHOWN} books.</p>}
      </section>

      <section aria-labelledby="person-history" className={SECTION_CLASSES}>
        <h2 id="person-history" className={SECTION_HEADING_CLASSES}>
          Suspension history
        </h2>
        {suspensions.length === 0 ? (
          <p className="text-sm text-muted">Never suspended.</p>
        ) : (
          <ol className="flex flex-col gap-4 text-sm">
            {suspensions.map((s) => (
              <li key={s.id} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                <p className="font-semibold">
                  Suspended {formatTimestampAsDate(s.suspended_at)} by {staffName(s.suspended_by)}
                </p>
                <p className="mt-1 break-words whitespace-pre-line">Reason: {s.reason}</p>
                <p className="mt-1 text-muted">{unpublishedLabel(s)}</p>
                <p className="mt-1 text-muted">
                  {s.lifted_at ? `Lifted ${formatTimestampAsDate(s.lifted_at)} by ${staffName(s.lifted_by)}` : "Still suspended"}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
