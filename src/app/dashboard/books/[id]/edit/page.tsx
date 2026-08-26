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
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { resolvePublishReadiness } from "@/lib/publish-readiness";
import { CONTRIBUTOR_ROLES } from "@/lib/contributor-roles";
import { formControlClasses, fileInputClasses } from "@/lib/form-styles";
import { DeleteBookButton } from "@/app/dashboard/delete-book-button";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import type { Book, Series, Contributor } from "@/lib/types";

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
    .select("stripe_payouts_enabled")
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

                <label className="flex flex-col gap-1 text-sm">
                  Preview excerpt (optional)
                  <textarea
                    name="previewText"
                    rows={8}
                    defaultValue={book.preview_text}
                    className={formControlClasses}
                  />
                  <span className="text-xs text-muted">
                    Shown to readers under &quot;Look inside&quot; before they buy —
                    the opening page or two works well. Leave blank to skip.
                  </span>
                </label>

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
                    Comma-separated. Helps readers find your book by terms beyond
                    its genre — up to 15.
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
                    Only if you already own one — Librum doesn&apos;t issue or
                    register ISBNs. Leave blank to skip.
                  </span>
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
            </section>

            <section>
              <h2 className="font-serif text-xl font-semibold">Files</h2>
              <div className="mt-4 flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Current cover</p>
                  {coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={coverUrl} alt="" className="h-24 w-16 rounded object-cover" />
                  ) : (
                    <div className="h-24 w-16 rounded bg-border" />
                  )}
                  <label className="flex flex-col gap-1 text-sm">
                    Replace cover image
                    <input
                      name="cover"
                      type="file"
                      accept="image/png,image/jpeg"
                      className={fileInputClasses}
                    />
                    <span className="text-xs text-muted">
                      JPEG or PNG · up to 5 MB. Leave blank to keep the current
                      cover.
                    </span>
                  </label>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    {manuscriptName ? `Current manuscript: ${manuscriptName}` : "No manuscript on file"}
                  </p>
                  <label className="flex flex-col gap-1 text-sm">
                    Replace manuscript
                    <input
                      name="manuscript"
                      type="file"
                      accept=".epub,application/epub+zip"
                      className={fileInputClasses}
                    />
                    <span className="text-xs text-muted">
                      EPUB · up to 50 MB. Leave blank to keep the current
                      manuscript. Replacing it updates the file existing
                      readers receive on their next download.
                    </span>
                  </label>
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
