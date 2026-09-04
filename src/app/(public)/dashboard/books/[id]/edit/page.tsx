import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  updateBook,
  addContributor,
  removeContributor,
  publishBook,
  unpublishBook,
  deleteBook,
} from "../../actions";
import { GENRES } from "@/lib/genres";
import { LANGUAGES, isSupportedLanguage } from "@/lib/languages";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { resolvePublishReadiness } from "@/lib/publish-readiness";
import { CONTRIBUTOR_ROLES } from "@/lib/contributor-roles";
import { formControlClasses } from "@/lib/form-styles";
import { DeleteBookButton } from "@/app/(public)/dashboard/delete-book-button";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { ManuscriptField } from "@/components/manuscript-field";
import { CoverField } from "@/components/cover-field";
import type { Book, Series, Contributor } from "@/lib/types";
import type { Metadata } from "next";

// LIBRUM 2.0 SEO-1: a static title, not "Edit <book title>" -- getting
// the real title would mean a second query inside generateMetadata()
// (a separate invocation from the page component below, sharing none of
// its already-fetched data) purely to label a browser tab, plus its own
// independent auth/ownership check to avoid leaking a draft's title to
// an unauthenticated request before the page body's own redirect ever
// runs. Not worth either cost for a private, authenticated-only route.
export const metadata: Metadata = {
  title: "Edit book",
};

// LIBRUM 2.0 PUBLISHING-UX-1 PART D: client-side-only bounds, purely a
// UX nicety mirroring actions.ts's own authoritative
// SUBTITLE_MAX_LENGTH/PUBLISHER_MAX_LENGTH/EDITION_MAX_LENGTH constants
// (not imported -- those are module-private to a "use server" file this
// task's own instructions protect from edits). A mismatch here has no
// security implication: the server re-validates and rejects an
// over-limit value independently, regardless of what a client sends.
const SUBTITLE_MAX_LENGTH = 300;
const PUBLISHER_MAX_LENGTH = 200;
const EDITION_MAX_LENGTH = 100;

// LIBRUM 2.0 UI-7: single structured Server Component page (no client
// boundary needed here -- DeleteBookButton is the one small existing
// client island, reused as-is, same as Dashboard's AuthorBookRow).
// Sections, in document order: Book Details, Files, Pricing, People,
// Publishing, Danger zone. Desktop gets a two-column layout (main form
// left, Publishing + Danger zone right) via CSS grid only -- no
// position:sticky, no client state -- so document/tab order stays
// exactly this list on every viewport; only the visual column changes.
//
// The ONE new query this pass adds is stripe_payouts_enabled on the
// existing per-page profile lookup -- needed so the Publishing
// section's readiness block can tell a paid draft whether payouts are
// actually set up. Nothing else about this page's query count changed.
//
// createBook/updateBook/publishBook/unpublishBook/deleteBook/
// addContributor/removeContributor are reused completely unchanged --
// this page only adds presentation and, for publish/unpublish/delete,
// UI that was simply missing before (confirmed absent in the UI-6 and
// UI-7 audits), not new business logic.
export default async function EditBookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const { error, success } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: book } = await supabase
    .from("books")
    .select("*")
    .eq("id", id)
    .single<Book>();

  if (!book || book.author_id !== user.id) {
    notFound();
  }

  const { data: series } = await supabase
    .from("series")
    .select("*")
    .eq("author_id", user.id)
    .order("title")
    .returns<Series[]>();

  const { data: contributors } = await supabase
    .from("book_contributors")
    .select("*")
    .eq("book_id", id)
    .order("created_at")
    .returns<Contributor[]>();

  // The one new query approved for UI-7 -- presentation/readiness only.
  // publishBook() independently re-derives this same value server-side
  // and remains the sole authority; this read can never be more than a
  // display hint.
  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_payouts_enabled, display_name")
    .eq("id", user.id)
    .single();

  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;
  const manuscriptName = book.file_path?.split("/").pop() ?? null;

  const readiness = resolvePublishReadiness({
    book,
    payoutsEnabled: !!profile?.stripe_payouts_enabled,
  });

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader title="Edit book" description={book.title} />
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

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_20rem] lg:items-start">
        <div className="flex flex-col gap-10">
          <form action={updateBook.bind(null, book.id)} className="flex flex-col gap-10">
            <section>
              <h2 className="font-serif text-xl font-semibold">Book Details</h2>
              <div className="mt-4 flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm">
                  Title
                  <input
                    name="title"
                    type="text"
                    required
                    defaultValue={book.title}
                    className={formControlClasses}
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Subtitle (optional)
                  <input
                    name="subtitle"
                    type="text"
                    defaultValue={book.subtitle ?? ""}
                    maxLength={SUBTITLE_MAX_LENGTH}
                    className={formControlClasses}
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Description (optional)
                  <textarea
                    name="description"
                    rows={4}
                    defaultValue={book.description}
                    className={formControlClasses}
                  />
                  <span className="text-xs text-muted">
                    A couple of sentences or more helps readers decide.
                  </span>
                </label>

                {/* LIBRUM 2.0 PUBLISHING-UX-1 PART D FINAL PRE-COMMIT
                    LANGUAGE PRESERVATION CORRECTION: no defaultValue
                    falls back to "sq" here -- see the historical-book-
                    safety note on resolveLanguage() (actions.ts). An
                    existing book with language=null shows the neutral
                    "Select language" prompt; saving without touching
                    this field resubmits that same empty selection,
                    which resolveLanguage() treats as "still no
                    language," never as a write of "sq."

                    books.language carries no DB CHECK (migration 044's
                    own comment explains why: the supported UI language
                    set may grow without a migration), so a book can
                    legitimately already hold a code this deployed
                    LANGUAGES doesn't (yet) recognize. The earlier
                    version of this field collapsed that case to the
                    same blank defaultValue as a genuinely-null book --
                    indistinguishable from "no language" once rendered,
                    so saving ANY unrelated field (e.g. Description)
                    would silently submit language="" and
                    resolveLanguage() would clear the real stored value
                    to null. That's the defect this correction fixes:
                    the synthetic <option> below (rendered only for a
                    non-null, unrecognized code) preserves the exact
                    stored value as a real, selectable option instead,
                    so an untouched save keeps submitting that same
                    code, not blank.

                    A native, plain <select>'s own defaultValue only
                    takes effect if some <option> in the list actually
                    has that value -- without the synthetic option, a
                    browser given no matching option falls back to
                    selecting the FIRST option ("Select language"),
                    silently reproducing the exact bug this correction
                    exists to fix. The synthetic option is therefore
                    load-bearing, not cosmetic.

                    KNOWN, EXPLICITLY REPORTED LIMITATION (see this
                    task's own required trace): resolveLanguage()
                    itself still rejects any non-empty value outside
                    LANGUAGES with a redirect, BEFORE updateBook()'s own
                    .update() call runs -- so resubmitting an untouched
                    unsupported code no longer silently clears it, but
                    it does still block that entire save (including
                    whatever unrelated field the author actually meant
                    to change) behind a "Please choose a supported
                    language" error. Fixing that fully needs a
                    server-side decision (a narrow preserve-unchanged-
                    value rule in updateBook()) explicitly out of scope
                    for this pass -- see this correction's own final
                    report. */}
                <label className="flex flex-col gap-1 text-sm">
                  Language (optional)
                  <select
                    name="language"
                    defaultValue={book.language ?? ""}
                    className={formControlClasses}
                  >
                    <option value="">Select language</option>
                    {book.language && !isSupportedLanguage(book.language) && (
                      <option value={book.language}>Current language · {book.language}</option>
                    )}
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Genre
                  <select
                    name="genre"
                    required
                    defaultValue={book.genre ?? ""}
                    className={formControlClasses}
                  >
                    <option value="" disabled>
                      Choose a genre
                    </option>
                    {GENRES.map((genre) => (
                      <option key={genre} value={genre}>
                        {genre}
                      </option>
                    ))}
                  </select>
                </label>

                <details className="rounded-lg border border-border px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium text-foreground">
                    Additional book details
                  </summary>
                  <div className="mt-4 flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                      Keywords (optional)
                      <input
                        name="keywords"
                        type="text"
                        defaultValue={book.keywords}
                        placeholder="e.g. space opera, first contact, hard sci-fi"
                        className={formControlClasses}
                      />
                      <span className="text-xs text-muted">
                        Comma-separated. Helps readers find your book by terms
                        beyond its genre — up to 15.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      ISBN (optional)
                      <input
                        name="isbn"
                        type="text"
                        defaultValue={book.isbn ?? ""}
                        placeholder="e.g. 978-3-16-148410-0"
                        className={formControlClasses}
                      />
                      <span className="text-xs text-muted">
                        Only if you already own one — Librum doesn&apos;t issue
                        or register ISBNs. Leave blank to skip.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      Publisher / imprint (optional)
                      <input
                        name="publisher"
                        type="text"
                        defaultValue={book.publisher ?? ""}
                        maxLength={PUBLISHER_MAX_LENGTH}
                        className={formControlClasses}
                      />
                      <span className="text-xs text-muted">
                        The publishing name for this edition, if applicable.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      Edition (optional)
                      <input
                        name="edition"
                        type="text"
                        defaultValue={book.edition ?? ""}
                        placeholder="e.g. First edition, Revised edition"
                        maxLength={EDITION_MAX_LENGTH}
                        className={formControlClasses}
                      />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      Originally published (optional)
                      <input
                        name="originalPublicationDate"
                        type="date"
                        defaultValue={book.original_publication_date ?? ""}
                        className={formControlClasses}
                      />
                      <span className="text-xs text-muted">
                        Only if this edition was first published elsewhere
                        before arriving on Librum.
                      </span>
                    </label>

                    {series && series.length === 0 && (
                      <p className="text-xs text-muted">
                        Want to group this with other books as a series?{" "}
                        <Link href="/dashboard/series" className="focus-ring rounded-sm underline">
                          Create a series first
                        </Link>
                        , then come back here.
                      </p>
                    )}

                    {series && series.length > 0 && (
                      <div className="flex gap-3">
                        <label className="flex flex-1 flex-col gap-1 text-sm">
                          Series (optional)
                          <select
                            name="seriesId"
                            defaultValue={book.series_id ?? ""}
                            className={formControlClasses}
                          >
                            <option value="">None</option>
                            {series.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          Position
                          <input
                            name="seriesPosition"
                            type="number"
                            min="1"
                            step="1"
                            defaultValue={book.series_position ?? ""}
                            placeholder="1"
                            className={`w-24 ${formControlClasses}`}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                </details>
              </div>
            </section>

            <section>
              <h2 className="font-serif text-xl font-semibold">Files</h2>
              <div className="mt-4 flex flex-col gap-6">
                <CoverField authorId={user.id} existingCoverUrl={coverUrl ?? undefined} />

                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    {manuscriptName ? `Current manuscript: ${manuscriptName}` : "No manuscript on file"}
                  </p>
                  <p className="text-xs text-muted">
                    Leave blank to keep your current manuscript. Replacing it updates
                    the file existing readers receive on their next download. Readers
                    can preview approximately the first 10% of your ebook — generated
                    automatically, no extra steps needed.
                  </p>
                  <ManuscriptField
                    bookTitle={book.title}
                    authorName={profile?.display_name ?? ""}
                    authorId={user.id}
                    existingFilename={manuscriptName ?? undefined}
                  />
                </div>
              </div>
            </section>

            <section>
              <h2 className="font-serif text-xl font-semibold">Pricing</h2>
              <div className="mt-4">
                <label className="flex flex-col gap-1 text-sm">
                  Price (USD)
                  <input
                    name="price"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    defaultValue={(book.price_cents / 100).toFixed(2)}
                    className={formControlClasses}
                  />
                  <span className="text-xs text-muted">
                    Set to $0 for a free ebook. Librum takes a{" "}
                    {PLATFORM_FEE_PERCENT}% platform fee — you keep the rest of
                    every sale.
                  </span>
                </label>
              </div>
            </section>

            <button type="submit" className={buttonClasses("primary", "md", "w-fit")}>
              Save changes
            </button>
          </form>

          <section className="border-t border-border pt-8">
            <h2 className="font-serif text-xl font-semibold">People</h2>
            <p className="mt-1 text-sm text-muted">
              Credit anyone besides yourself — an illustrator, translator,
              narrator, or co-author. Just a name and a role, no Librum account
              needed.
            </p>

            {contributors && contributors.length > 0 && (
              <ul className="mt-4 flex flex-col gap-2 text-sm">
                {contributors.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2"
                  >
                    <span>
                      {c.name} <span className="text-muted">· {c.role}</span>
                    </span>
                    <form action={removeContributor.bind(null, book.id, c.id)}>
                      <button
                        type="submit"
                        className="focus-ring rounded-sm text-xs text-red-700 hover:underline"
                      >
                        Remove
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            <form
              action={addContributor.bind(null, book.id)}
              className="mt-4 flex flex-wrap items-end gap-3"
            >
              <label className="flex flex-col gap-1 text-sm">
                Name
                <input
                  name="name"
                  type="text"
                  required
                  placeholder="e.g. Jane Doe"
                  className={formControlClasses}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Role
                <select name="role" required defaultValue="" className={formControlClasses}>
                  <option value="" disabled>
                    Choose a role
                  </option>
                  {CONTRIBUTOR_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={buttonClasses("outline", "md")}>
                Add contributor
              </button>
            </form>
          </section>
        </div>

        <div className="flex flex-col gap-6">
          <section className="rounded-lg border border-border bg-surface p-4 shadow-sm">
            <h2 className="font-serif text-lg font-semibold">Publishing</h2>
            <p className="mt-2 text-sm">
              Status: <span className="font-medium">{book.status === "draft" ? "Draft" : "Published"}</span>
            </p>

            {book.status === "draft" ? (
              <>
                {readiness.payoutBlocked ? (
                  <Alert
                    variant="warning"
                    title="Finish payout setup to publish paid books."
                    className="mt-4"
                  >
                    <Link
                      href="/dashboard/payouts"
                      className="focus-ring rounded-sm font-medium underline"
                    >
                      Manage payouts
                    </Link>
                  </Alert>
                ) : (
                  <p className="mt-4 text-sm text-muted">Ready to publish.</p>
                )}

                {readiness.recommended.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Recommended before publishing
                    </p>
                    <ul className="mt-2 flex flex-col gap-1 text-sm">
                      {readiness.recommended.map((item) => (
                        <li key={item.label} className="flex items-start gap-2">
                          <span aria-hidden="true">{item.done ? "✓" : "○"}</span>
                          <span className={item.done ? "text-muted line-through" : undefined}>
                            {item.label}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <form action={publishBook.bind(null, book.id)} className="mt-4">
                  <button
                    type="submit"
                    disabled={readiness.payoutBlocked}
                    className={buttonClasses(
                      "primary",
                      "md",
                      "w-full disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    Publish book
                  </button>
                </form>
              </>
            ) : (
              <>
                <p className="mt-4 text-sm text-muted">
                  Removes it from the Bookstore. Readers who already own it
                  keep their download.
                </p>
                <form action={unpublishBook.bind(null, book.id)} className="mt-4">
                  <button type="submit" className={buttonClasses("outline", "md", "w-full")}>
                    Unpublish book
                  </button>
                </form>
              </>
            )}
          </section>

          <section className="rounded-lg border border-dashed border-border p-4">
            <h2 className="font-serif text-sm font-semibold text-muted">Danger zone</h2>
            <p className="mt-1 text-xs text-muted">This can&apos;t be undone.</p>
            <form action={deleteBook.bind(null, book.id)} className="mt-3">
              <DeleteBookButton title={book.title} />
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
