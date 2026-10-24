import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { formControlClasses } from "@/lib/form-styles";
import { buttonClasses } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import type { Metadata } from "next";
import {
  PEOPLE_KINDS,
  PEOPLE_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
  parsePeopleKind,
  parsePeoplePage,
  parsePeopleSearch,
  peopleCountLabel,
  peopleListHref,
  personBankLabel,
  personBooksLabel,
  personSalesLabel,
  personStatusLabel,
  personTypeLabel,
  type PeopleKind,
  type PersonRow,
} from "./people-logic";

export const metadata: Metadata = {
  title: "People",
};

// Reads the accounts on every request (anyone can sign up at any time).
export const dynamic = "force-dynamic";

// PEOPLE-1, per the mockup's People page: every account, searchable by
// account name, pen name or email (Renato's 8a), filtered Everyone /
// Authors / Readers / Suspended, 50 per page, newest first, with the
// mockup's columns (9a). requireStaff("people.view") is this page's own
// gate; admin_list_people() checks people.view itself, so the read uses
// the staff member's own session, never the service-role client. Each
// row opens /admin/people/[id]. Suspend and Lift arrive with PEOPLE-2.
const LOAD_ERROR = "Couldn't load the people. Please try again.";

type ListResult = { ok: true; rows: PersonRow[]; total: number; authors: number; readers: number } | { ok: false };

async function loadPeople(kind: PeopleKind, q: string, page: number): Promise<ListResult> {
  const supabase = await createClient();
  const offset = (page - 1) * PEOPLE_PAGE_SIZE;
  // One row of each kind is enough to read its total for the eyebrow.
  const [list, authors, readers] = await Promise.all([
    supabase.rpc("admin_list_people", { p_query: q || null, p_kind: kind, p_limit: PEOPLE_PAGE_SIZE, p_offset: offset }),
    supabase.rpc("admin_list_people", { p_kind: "authors", p_limit: 1 }),
    supabase.rpc("admin_list_people", { p_kind: "readers", p_limit: 1 }),
  ]);
  if (list.error || authors.error || readers.error) {
    console.error("admin people: list read failed", {
      list: list.error,
      authors: authors.error,
      readers: readers.error,
    });
    return { ok: false };
  }
  const rows = (list.data ?? []) as PersonRow[];
  return {
    ok: true,
    rows,
    // On a page past the end there are no rows to read the total from.
    total: Number(rows[0]?.total_count ?? 0),
    authors: Number(((authors.data ?? []) as PersonRow[])[0]?.total_count ?? 0),
    readers: Number(((readers.data ?? []) as PersonRow[])[0]?.total_count ?? 0),
  };
}

const STATUS_CLASSES = {
  Active: "text-foreground",
  Suspended: "rounded-[3px] bg-[#f6deda] px-2 py-1 text-xs font-bold tracking-wide text-[#8e2a1e] uppercase",
} as const;

// The phone card's one line of facts; a reader's "-" columns are left out.
function personCardSummary(person: PersonRow): string {
  const parts = [personTypeLabel(person)];
  const books = personBooksLabel(person);
  const sales = personSalesLabel(person);
  const bank = personBankLabel(person);
  if (books !== "-") parts.push(`Books ${books}`);
  if (sales !== "-") parts.push(`Sales ${sales}`);
  if (bank !== "-") parts.push(`Bank ${bank.toLowerCase()}`);
  parts.push(`Joined ${formatTimestampAsDate(person.joined_at)}`);
  return parts.join(" · ");
}

export default async function AdminPeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; show?: string | string[]; page?: string | string[] }>;
}) {
  await requireStaff("people.view");

  const params = await searchParams;
  const kind = parsePeopleKind(params.show);
  const q = parsePeopleSearch(params.q);
  const page = parsePeoplePage(params.page);

  const result = await loadPeople(kind, q, page);
  const lastPage = result.ok ? Math.max(1, Math.ceil(result.total / PEOPLE_PAGE_SIZE)) : 1;

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <div>
        <p className="text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">
          {result.ok ? `${result.authors} authors · ${result.readers} readers` : "Team"}
        </p>
        <h1 className="mt-1 font-serif text-[2rem] font-bold text-primary md:text-[2.5rem]">People</h1>
        <p className="mt-1 text-sm text-muted">Every account on Librum. Open a person to see their pen names, books and history.</p>
      </div>

      <form action="/admin/people" method="get" role="search" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        {kind !== "everyone" && <input type="hidden" name="show" value={kind} />}
        <label htmlFor="admin-people-q" className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
          Search by name, pen name or email
          <input
            id="admin-people-q"
            type="search"
            name="q"
            defaultValue={q}
            maxLength={PEOPLE_SEARCH_MAX_LENGTH}
            className={`${formControlClasses} min-h-11 w-full`}
          />
        </label>
        <button type="submit" className={buttonClasses("primary", "md", "min-h-11 shrink-0 rounded-[3px] px-5")}>
          Search
        </button>
      </form>

      <nav aria-label="Show" className="flex flex-wrap gap-2">
        {PEOPLE_KINDS.map((option) => {
          const active = option.value === kind;
          return (
            <Link
              key={option.value}
              href={peopleListHref(option.value, q)}
              aria-current={active ? "true" : undefined}
              className={`focus-ring inline-flex min-h-11 items-center rounded-control border px-4 text-sm ${
                active
                  ? "border-primary bg-primary font-semibold text-primary-foreground"
                  : "border-border bg-surface text-foreground hover:bg-surface-hover"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </nav>

      {!result.ok ? (
        <Alert variant="error">{LOAD_ERROR}</Alert>
      ) : result.rows.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-sm text-muted">No one matches.</p>
      ) : (
        <section aria-label="People" className="min-w-0 rounded-card border border-border bg-surface">
          <p className="border-b border-border px-4 py-3 text-sm text-muted">
            {peopleCountLabel(result.total)}
            {lastPage > 1 && ` · page ${page} of ${lastPage}`}
          </p>
          {/* Desktop: a real table. Phones: stacked cards below, from the
              same rows, as on /admin/staff -- eight columns do not fit a
              390px viewport. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">{q ? `People matching “${q}”` : "People"}</caption>
              <thead>
                <tr className="text-[0.8125rem] text-muted">
                  <th scope="col" className="px-4 py-3 font-semibold">Name</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Type</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Books</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Sales</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Bank account</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Joined</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((person) => {
                  const status = personStatusLabel(person);
                  const bank = personBankLabel(person);
                  return (
                    <tr key={person.user_id} className="border-t border-border align-top">
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/people/${person.user_id}`}
                          className="focus-ring inline-flex min-h-11 items-center font-semibold break-words text-primary"
                        >
                          {person.display_name}
                        </Link>
                        {person.email && <span className="block break-words text-muted">{person.email}</span>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{personTypeLabel(person)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{personBooksLabel(person)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{personSalesLabel(person)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {bank === "Not added" ? <span className="font-semibold text-[#6b4e00]">{bank}</span> : bank}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatTimestampAsDate(person.joined_at)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={STATUS_CLASSES[status]}>{status}</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Link
                          href={`/admin/people/${person.user_id}`}
                          className="focus-ring inline-flex min-h-11 items-center underline"
                          aria-label={`View ${person.display_name}`}
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden">
            {result.rows.map((person) => {
              const status = personStatusLabel(person);
              return (
                <li key={person.user_id} className="border-t border-border first:border-t-0">
                  <Link
                    href={`/admin/people/${person.user_id}`}
                    className="focus-ring flex min-h-11 flex-col gap-1 px-4 py-3 text-sm hover:bg-surface-hover"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0 font-semibold break-words text-primary">{person.display_name}</span>
                      <span className={`shrink-0 ${STATUS_CLASSES[status]}`}>{status}</span>
                    </span>
                    {person.email && <span className="break-words text-muted">{person.email}</span>}
                    <span className="text-muted">{personCardSummary(person)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {result.ok && lastPage > 1 && (
        <nav aria-label="Pages" className="flex flex-wrap justify-between gap-3">
          {page > 1 ? (
            <Link href={peopleListHref(kind, q, page - 1)} className={buttonClasses("outline", "md", "min-h-11 rounded-[3px]")}>
              Newer
            </Link>
          ) : (
            <span />
          )}
          {page < lastPage && (
            <Link href={peopleListHref(kind, q, page + 1)} className={buttonClasses("outline", "md", "min-h-11 rounded-[3px]")}>
              Older
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
