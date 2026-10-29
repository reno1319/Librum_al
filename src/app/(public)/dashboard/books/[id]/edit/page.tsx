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
  cancelBookReview,
} from "../../actions";
import { GENRES } from "@/lib/genres";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import {
  MAXIMUM_CATALOG_PRICE_ALL,
  MINIMUM_PAID_CATALOG_PRICE_ALL,
  groupAllDigits,
} from "@/lib/catalog-price";
import { resolvePublishReadiness } from "@/lib/publish-readiness";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { CONTRIBUTOR_ROLES, contributorRoleLabel } from "@/lib/contributor-roles";
import { formControlClasses } from "@/lib/form-styles";
import { DeleteBookButton } from "@/app/(public)/dashboard/delete-book-button";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { ManuscriptField } from "@/components/manuscript-field";
import { CoverField } from "@/components/cover-field";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { getManuscriptLabel } from "@/lib/manuscript-label";
import { getCatalogSchemaFeatures } from "@/lib/catalog-schema-features";
import { getRightsDeclarationState } from "@/lib/book-rights";
import { loadAuthorTakedownNoticeForBook } from "@/lib/book-takedowns";
import { buildAuthorTakedownNoticeLines } from "@/lib/takedown-reasons";
import { getBookReviewState } from "@/lib/book-reviews";
import {
  CANCEL_REVIEW_LABEL,
  IN_REVIEW_LABEL,
  LIVE_FILES_WARNING,
  buildAuthorSentBackNoticeLines,
  publishControlLabel,
} from "@/lib/book-review-copy";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { RIGHTS_BASES, RIGHTS_STATEMENTS } from "@/lib/rights-statements";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { FormDraftKeeper } from "@/components/form-draft-keeper";
import { PriceChangeConfirm } from "@/components/price-change-confirm";
import { CheckedBookField } from "@/components/checked-book-field";
import type { Book, Series, Contributor } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import type { Metadata } from "next";

// LIBRUM 2.0 SEO-1: a static title, not "Edit <book title>" -- getting
// the real title would mean a second query inside generateMetadata()
// (a separate invocation from the page component below, sharing none of
// its already-fetched data) purely to label a browser tab, plus its own
// independent auth/ownership check to avoid leaking a draft's title to
// an unauthenticated request before the page body's own redirect ever
// runs. Not worth either cost for a private, authenticated-only route.
export const metadata: Metadata = {
  title: "Ndryshoni librin",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (books.price_all is rendered for editing below).
export const dynamic = "force-dynamic";

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
// F4 (P1): books.pen_name's own 1-120 character check.
const PEN_NAME_MAX_LENGTH = 120;

// F4 (D3): the existing generic sentence, shown in the Publishing box
// when the book's rights choice cannot be read (before the migration, or
// a read error); Publish is disabled with it.
const PUBLISH_NOT_POSSIBLE_YET_MESSAGE =
  "Libri juaj nuk u publikua dot ende. Provoni përsëri nga paneli juaj";

// QA: the "Save changes" fields whose typed values come back after
// updateBook rejects the form. Plain fields only -- the cover and
// manuscript pickers carry upload paths and are never copied (see
// src/lib/form-draft.ts). F4: "penName" joins them; the Rights radios
// are not kept (form-draft never copies radios) and show the stored
// choice again after an error, because the page re-reads it.
const EDIT_BOOK_FORM_ID = "edit-book-form";
const EDIT_BOOK_DRAFT_FIELDS = [
  "title",
  "penName",
  "subtitle",
  "description",
  "genre",
  "keywords",
  "isbn",
  "publisher",
  "edition",
  "originalPublicationDate",
  "seriesId",
  "seriesPosition",
  "price",
] as const;

// LIBRUM 2.0 UI-7: single structured Server Component page (no client
// boundary needed here -- DeleteBookButton is the one small existing
// client island, reused as-is, same as Dashboard's AuthorBookRow).
// Sections, in document order: Book Details, Files, Pricing, People,
// Publishing, Danger zone. Desktop gets a two-column layout (main form
// left, Publishing + Danger zone right) via CSS grid only -- no
// position:sticky, no client state -- so document/tab order stays
// exactly this list on every viewport; only the visual column changes.
//
// PR-G: this pass once added stripe_payouts_enabled to the existing
// per-page profile lookup, so the Publishing section's readiness block
// could tell a paid draft whether payouts were set up. That column is
// gone from the select again -- paid publishing is decided by
// canPublishPaidTitle(), a server capability rather than an
// author-specific column -- and the profile lookup is back to reading
// only the author's names.
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
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders books.price_all
  // for editing (exhaustive route audit) -- checked as the first
  // statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const { error, success } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // PEN-NAMES-2 (D4): books.pen_name is gone; the book's pen name is
  // embedded from public_pen_names. An own-row read of the base table.
  const { data: book } = await supabase
    .from("books")
    .select("*, pen:public_pen_names(id, name)")
    .eq("id", id)
    .eq("author_id", user.id)
    .single<Book & { pen: PenNameRef | null }>();

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

  // Presentation only. publishBook() independently re-derives the
  // publishing decision server-side and remains the sole authority;
  // nothing read here can ever be more than a display hint.
  // LIBRUM 2.0 AUTHOR-1B: public_author_name added alongside
  // display_name -- resolved via resolvePublicAuthorName() below, so the
  // name threaded into ManuscriptField (and from there into the EPUB's
  // dc:creator) is the same reader-facing identity shown on the book's
  // own page, never the private account name.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, public_author_name")
    .eq("id", user.id)
    .single();

  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;
  // iPhone step (I3): "EPUB file", never the storage file name (a UUID).
  const manuscriptLabel = getManuscriptLabel(book.file_path);

  // F4 (D1/P4): which new fields can be shown, and the book's rights
  // choice read three ways. `unavailable` (before the migration, or a
  // read error) hides the Rights choice, shows the generic notice and
  // disables Publish; the server's publish gate decides on its own.
  // ADMIN-2-TAKEDOWN (G, M4): an active Librum takedown replaces the
  // Publish control with its notice; an unreadable takedown state shows
  // the generic sentence and disables Publish (the server gate refuses
  // both on its own).
  // ADMIN-3-REVIEW (B, E, F, N9): the book's review state from
  // book_review_state() -- pending, whether Librum's approval still
  // matches the current files, and the newest send back. Unreadable
  // disables the publish control (performPublish refuses on its own).
  const [schemaFeatures, rightsState, takedown, { data: penNames }, reviewState] = await Promise.all([
    getCatalogSchemaFeatures(),
    getRightsDeclarationState(book.id),
    loadAuthorTakedownNoticeForBook(supabase, book.id),
    // PEN-NAMES-1 (10a): the author's own pen names for the box's
    // suggestions (RLS: own rows).
    supabase
      .from("pen_names")
      .select("name, is_default")
      .eq("author_id", user.id)
      .order("created_at")
      .returns<{ name: string; is_default: boolean }[]>(),
    getBookReviewState(supabase, book.id),
  ]);
  const isLive = book.status === "published";
  const inReview = !takedown.notice && book.status === "draft" && reviewState.kind === "ok" && reviewState.pending;
  const sentBack =
    !takedown.notice && book.status === "draft" && !inReview && reviewState.kind === "ok"
      ? reviewState.latestSentBack
      : null;
  const approvalValid = reviewState.kind === "ok" && reviewState.approvalValid;
  const penNameSuggestions = (penNames ?? []).filter((p) => !p.is_default).map((p) => p.name);
  // The box shows the book's pen name, blank for the default one (blank
  // means "your author name", as before).
  const defaultPenName = (penNames ?? []).find((p) => p.is_default)?.name ?? null;
  const bookPenName = book.pen?.name && book.pen.name !== defaultPenName ? book.pen.name : "";
  const currentRightsBasis = rightsState.kind === "present" ? rightsState.declaration.basis : null;
  const authorPublicName = resolvePublicAuthorName(profile);

  const readiness = resolvePublishReadiness({
    book,
    paidPublishingAvailable: canPublishPaidTitle(),
    hasRightsDeclaration: rightsState.kind === "present",
  });

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Kthehuni te paneli
      </Link>

      <div className="mt-2">
        <PageHeader title="Ndryshoni librin" description={book.title} />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      <FormDraftKeeper
        formId={EDIT_BOOK_FORM_ID}
        storageKey={`librum:edit-book-draft:${book.id}`}
        fieldNames={EDIT_BOOK_DRAFT_FIELDS}
        restore={Boolean(error)}
        notice="Ndryshimet tuaja nuk u ruajtën, por ajo që shkruat është ende në formularin më poshtë. Rregulloni problemin më sipër dhe ruajeni përsëri. Kopertinën ose dorëshkrimin që zgjodhët duhet ta zgjidhni përsëri."
      />
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_20rem] lg:items-start">
        <div className="flex flex-col gap-10">
          <form
            id={EDIT_BOOK_FORM_ID}
            action={updateBook.bind(null, book.id)}
            className="flex flex-col gap-10"
          >
            <section id="details" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal">Të dhënat e librit</h2>
              <div className="mt-4 flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm">
                  Titulli
                  <input
                    name="title"
                    type="text"
                    required
                    defaultValue={book.title}
                    className={formControlClasses}
                  />
                </label>

                {/* F4 (P1, Q1 = a): directly under Title. Cleared to the
                    default pen name when emptied. PEN-NAMES-2: always
                    shown (pen names exist since PEN-NAMES-1). */}
                {(
                  <label className="flex flex-col gap-1 text-sm">
                    Pseudonimi (opsional)
                    <input
                      name="penName"
                      type="text"
                      defaultValue={bookPenName}
                      maxLength={PEN_NAME_MAX_LENGTH}
                      list={penNameSuggestions.length > 0 ? "edit-pen-name-suggestions" : undefined}
                      autoComplete="off"
                      className={formControlClasses}
                    />
                    {penNameSuggestions.length > 0 && (
                      <datalist id="edit-pen-name-suggestions">
                        {penNameSuggestions.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    )}
                    {authorPublicName && (
                      <span className="text-sm text-muted">
                        Lëreni bosh për të përdorur emrin tuaj si autor, {authorPublicName}.
                      </span>
                    )}
                    {/* PEN-NAMES-1 (10a, 14a). */}
                    <span className="text-sm text-muted">
                      Një emër i ri bëhet pseudonim i ri me faqen e vet të autorit.
                      {book.series_id &&
                        " Ky libër është në një seri: hiqeni nga seria para se t'i ndryshoni pseudonimin."}
                    </span>
                  </label>
                )}

                <label className="flex flex-col gap-1 text-sm">
                  Nëntitulli (opsional)
                  <input
                    name="subtitle"
                    type="text"
                    defaultValue={book.subtitle ?? ""}
                    maxLength={SUBTITLE_MAX_LENGTH}
                    className={formControlClasses}
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Përshkrimi
                  <textarea
                    name="description"
                    rows={4}
                    defaultValue={book.description}
                    className={formControlClasses}
                  />
                  <span className="text-sm text-muted">
                    Disa fjali ose më shumë i ndihmojnë lexuesit të vendosin.
                  </span>
                </label>

                {/* ALBANIAN-9: the book language picker is gone (Renato,
                    10-28). The form sends no "language" field, so
                    updateBook() leaves books.language untouched
                    (resolveLanguageForUpdate "omit"). */}

                <label className="flex flex-col gap-1 text-sm">
                  Zhanri
                  <select
                    name="genre"
                    required
                    defaultValue={book.genre ?? ""}
                    className={formControlClasses}
                  >
                    <option value="" disabled>
                      Zgjidhni një zhanër
                    </option>
                    {GENRES.map((genre) => (
                      <option key={genre} value={genre}>
                        {genre}
                      </option>
                    ))}
                  </select>
                </label>

                <details className="rounded-card border border-border px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium text-foreground">
                    Të dhëna të tjera për librin
                  </summary>
                  <div className="mt-4 flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                      Fjalë kyçe (opsionale)
                      <input
                        name="keywords"
                        type="text"
                        defaultValue={book.keywords}
                        placeholder="p.sh. dashuri, luftë, histori familjare"
                        className={formControlClasses}
                      />
                      <span className="text-sm text-muted">
                        Të ndara me presje. Ndihmojnë lexuesit ta gjejnë librin tuaj
                        me fjalë përtej zhanrit, deri në 15.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      ISBN (opsional)
                      <CheckedBookField
                        kind="isbn"
                        id="edit-book-isbn"
                        name="isbn"
                        defaultValue={book.isbn ?? ""}
                        placeholder="p.sh. 978-3-16-148410-0"
                      />
                      <span className="text-sm text-muted">
                        Vetëm nëse e keni tashmë një të tillë. Librum nuk lëshon
                        e as regjistron ISBN. Lëreni bosh nëse nuk keni.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      Botuesi / shtëpia botuese (opsional)
                      <input
                        name="publisher"
                        type="text"
                        defaultValue={book.publisher ?? ""}
                        maxLength={PUBLISHER_MAX_LENGTH}
                        className={formControlClasses}
                      />
                      <span className="text-sm text-muted">
                        Emri botues i këtij botimi, nëse ka.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      Botimi (opsional)
                      <input
                        name="edition"
                        type="text"
                        defaultValue={book.edition ?? ""}
                        placeholder="p.sh. Botimi i parë, Botim i rishikuar"
                        maxLength={EDITION_MAX_LENGTH}
                        className={formControlClasses}
                      />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      Botuar fillimisht (opsional)
                      <CheckedBookField
                        kind="pastDate"
                        id="edit-book-original-publication-date"
                        name="originalPublicationDate"
                        defaultValue={book.original_publication_date ?? ""}
                      />
                      <span className="text-sm text-muted">
                        Vetëm nëse ky botim është botuar diku tjetër
                        para se të vinte në Librum.
                      </span>
                    </label>

                    {series && series.length === 0 && (
                      <p className="text-sm text-muted">
                        Doni ta gruponi me libra të tjerë në një seri?{" "}
                        {/* FIX1 (X11): a new tab, so unsaved edits stay. */}
                        <Link
                          href="/dashboard/series"
                          target="_blank"
                          rel="noopener"
                          className="focus-ring rounded-sm underline"
                        >
                          Krijoni fillimisht një seri
                          <span className="sr-only"> (hapet në një skedë të re)</span>
                        </Link>
                        , pastaj kthehuni këtu.
                      </p>
                    )}

                    {series && series.length > 0 && (
                      <div className="flex gap-3">
                        <label className="flex flex-1 flex-col gap-1 text-sm">
                          Seria (opsionale)
                          <select
                            name="seriesId"
                            defaultValue={book.series_id ?? ""}
                            className={formControlClasses}
                          >
                            <option value="">Asnjë</option>
                            {series.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          Vendi në seri
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

                {/* F4 (P3, Q3 = a): the last block of Book details, with
                    the book's current choice preselected. Saved with
                    "Save changes"; a new record is made only when the
                    choice changes. Sentences from RIGHTS_STATEMENTS. */}
                {schemaFeatures.rights && rightsState.kind !== "unavailable" && (
                  <fieldset className="flex flex-col gap-3">
                    <legend className="mb-3 font-bold text-foreground">Të drejtat</legend>
                    {RIGHTS_BASES.map((basis) => (
                      <label
                        key={basis}
                        className="flex cursor-pointer items-center gap-3.5 rounded-[4px] border border-[#c9c0ae] bg-surface p-4 has-checked:border-2 has-checked:border-primary has-checked:bg-[#f4f8f5]"
                      >
                        <input
                          type="radio"
                          name="rightsBasis"
                          value={basis}
                          defaultChecked={currentRightsBasis === basis}
                          className="focus-ring h-5 w-5 shrink-0 accent-primary"
                        />
                        <span className="text-foreground">{RIGHTS_STATEMENTS[basis].text}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            </section>

            <section id="files" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal">Skedarët</h2>
              <div className="mt-4 flex flex-col gap-6">
                {/* ADMIN-3-REVIEW (C): a live book's new file or cover
                    goes back through review; said before the pickers. */}
                {isLive && <Alert variant="warning" title={LIVE_FILES_WARNING} />}
                <CoverField authorId={user.id} existingCoverUrl={coverUrl ?? undefined} />

                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    {manuscriptLabel ? `Dorëshkrimi aktual: ${manuscriptLabel}` : "Nuk ka dorëshkrim"}
                  </p>
                  <p className="text-sm text-muted">
                    Lëreni bosh për të mbajtur dorëshkrimin aktual. Një skedar i ri
                    kontrollohet nga Librum para se ta marrin lexuesit. Lexuesit mund të
                    shohin rreth 10% të parë të e-librit tuaj. Kjo krijohet
                    automatikisht, pa hapa të tjerë.
                  </p>
                  <ManuscriptField
                    bookTitle={book.title}
                    authorName={resolvePublicAuthorName(profile) ?? ""}
                    authorId={user.id}
                  />
                </div>
              </div>
            </section>

            <section id="pricing" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal">Çmimi</h2>
              <div className="mt-4">
                {/* ALL-WIRING-2: an ALL text field, not a USD number
                    field. `type="number"` is wrong for this input in two
                    separate ways: its value property silently discards
                    what the browser considers invalid, which made the
                    Albanian comma form ("990,00") literally unreachable,
                    and `step="0.01"` advertised a fractional lek price
                    that the catalog cannot store. inputMode="decimal"
                    keeps the numeric keypad on a phone.

                    A legacy row with no authored ALL price renders
                    BLANK, never a converted `price_cents`. Blank is the
                    honest state -- this book has no ALL price -- and the
                    field is required, so saving any other edit to the
                    book forces the author to supply one. That single
                    save is also what returns the book to listings and
                    search. */}
                {/* iPhone step (I2): the same price box as Add a book
                    step 3 (upload-wizard.tsx), copied, not shared: the
                    wizard's source-text tests pin its own markup. This
                    page has no per-field price error, so the border is
                    always the control colour. */}
                <label className="flex flex-col gap-1 text-sm">
                  Çmimi (lekë)
                  <span className="flex w-full max-w-[17.5rem] items-stretch overflow-hidden rounded-[4px] border border-[#8c8472] bg-surface focus-within:shadow-[var(--focus-ring)]">
                    <input
                      name="price"
                      type="text"
                      inputMode="decimal"
                      required
                      defaultValue={book.price_all == null ? "" : String(book.price_all)}
                      className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2.5 text-lg outline-none"
                    />
                    <span
                      aria-hidden="true"
                      className="flex items-center bg-surface-hover px-4 font-bold text-foreground"
                    >
                      lekë
                    </span>
                  </span>
                  <span className="text-sm text-muted">
                    Lekë të plota: 0 për e-libër falas, ose nga {MINIMUM_PAID_CATALOG_PRICE_ALL} deri në{" "}
                    {groupAllDigits(MAXIMUM_CATALOG_PRICE_ALL)}. Librum mban një tarifë platforme prej{" "}
                    {PLATFORM_FEE_PERCENT}%; pjesa tjetër e çdo shitjeje
                    është e juaja.
                  </span>
                </label>
                {/* LIVE-PRICE-CONFIRM-1: a live book's new price needs a
                    tick (updateBook checks it). */}
                {isLive && <PriceChangeConfirm currentPriceAll={book.price_all ?? null} />}
              </div>
            </section>

            <button type="submit" className={buttonClasses("primary", "md", "w-fit")}>
              Ruani ndryshimet
            </button>
          </form>

          <section className="border-t border-border pt-8">
            <h2 className="font-serif text-xl font-normal">Bashkëpunëtorët</h2>
            <p className="mt-1 text-sm text-muted">
              Përmendni këdo tjetër përveç jush: ilustrues, përkthyes,
              lexues ose bashkautor. Mjafton emri dhe roli; nuk duhet
              llogari në Librum.
            </p>

            {contributors && contributors.length > 0 && (
              <ul className="mt-4 flex flex-col gap-2 text-sm">
                {contributors.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface px-3 py-2"
                  >
                    <span>
                      {c.name} <span className="text-muted">· {contributorRoleLabel(c.role)}</span>
                    </span>
                    <form action={removeContributor.bind(null, book.id, c.id)}>
                      <button
                        type="submit"
                        className="focus-ring rounded-sm text-xs text-red-700 hover:underline"
                      >
                        Hiqeni
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
                Emri
                <input
                  name="name"
                  type="text"
                  required
                  placeholder="p.sh. Arta Hoxha"
                  className={formControlClasses}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Roli
                <select name="role" required defaultValue="" className={formControlClasses}>
                  <option value="" disabled>
                    Zgjidhni një rol
                  </option>
                  {CONTRIBUTOR_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {contributorRoleLabel(role)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={buttonClasses("outline", "md")}>
                Shtoni bashkëpunëtor
              </button>
            </form>
          </section>
        </div>

        <div className="flex flex-col gap-6">
          {/* PHONE PASS (D3): the Dashboard row menu's Unpublish (and the
              other menu items above) jump to these section ids. */}
          <section id="publishing" className="scroll-mt-6 rounded-card border border-border bg-surface p-4 shadow-sm">
            <h2 className="font-serif text-lg font-normal">Publikimi</h2>
            <p className="mt-2 text-sm">
              Gjendja:{" "}
              <span className="font-medium">
                {takedown.notice
                  ? "Hequr nga Librum"
                  : inReview
                    ? IN_REVIEW_LABEL
                    : book.status === "draft"
                      ? "Draft"
                      : "I publikuar"}
              </span>
            </p>

            {/* PREVIEW-1 (A5, Renato 6a): the book's own page, as readers
                will see it, before it's live. A new tab (like FIX1 X11's
                series link), so unsaved edits here stay; it shows what was
                last saved. */}
            {book.status !== "published" && (
              <p className="mt-2 text-sm text-muted">
                <Link
                  href={`/libra/${book.id}`}
                  target="_blank"
                  rel="noopener"
                  className="focus-ring rounded-sm font-medium text-foreground underline"
                >
                  Shikoni faqen e librit para botimit
                  <span className="sr-only"> (hapet në një skedë të re)</span>
                </Link>
                . Tregon ndryshimet e ruajtura së fundmi.
              </p>
            )}

            {takedown.notice ? (
              <Alert variant="error" className="mt-4">
                {buildAuthorTakedownNoticeLines(takedown.notice, formatTimestampAsDate).map((line, index) => (
                  <p
                    key={index}
                    className={index === 0 ? "font-semibold" : "mt-1 whitespace-pre-wrap break-words"}
                  >
                    {line}
                  </p>
                ))}
              </Alert>
            ) : inReview ? (
              // ADMIN-3-REVIEW (E, F): waiting for Librum -- no timing
              // promise; the author may take it back to a draft.
              <>
                <p className="mt-4 text-sm text-muted">
                  Librum po e kontrollon librin tuaj. Do t&apos;ju njoftojmë kur të publikohet.
                </p>
                <form action={cancelBookReview.bind(null, book.id)} className="mt-4">
                  <button type="submit" className={buttonClasses("outline", "md", "w-full")}>
                    {CANCEL_REVIEW_LABEL}
                  </button>
                </form>
              </>
            ) : book.status === "draft" ? (
              <>
                {sentBack && (
                  <Alert variant="warning" className="mt-4">
                    {buildAuthorSentBackNoticeLines(sentBack, formatTimestampAsDate).map((line, index) => (
                      <p
                        key={index}
                        className={index === 0 ? "font-semibold" : "mt-1 whitespace-pre-wrap break-words"}
                      >
                        {line}
                      </p>
                    ))}
                  </Alert>
                )}
                {/* PR-G: this replaced "Finish payout setup to publish paid
                    books." above a "Manage payouts" link. Since the Stripe
                    prerequisite was removed, canPublishPaidTitle() is the
                    sole paid-publishing gate, and no payout setting can
                    change its answer (Stripe, its payouts page and
                    webhook have since been removed entirely). So a payouts
                    link could only ever send an author somewhere that
                    cannot unblock them, and it was correctly removed from
                    THIS publishing notice. The copy must stay CONDITIONAL and
                    never become a hardcoded banner: with
                    PAID_PUBLISHING_MODE set on the protected staging
                    deployment this branch correctly disappears. */}
                {/* ALL-WIRING-2: the missing-price blocker is checked
                    FIRST and is a separate notice, because it is the one
                    blocker the author can clear themselves. Telling them
                    "paid publishing hasn't launched" for a book with no
                    price at all would name the wrong obstacle; the two
                    are mutually exclusive by construction in
                    resolvePublishReadiness. */}
                {readiness.missingAllPrice ? (
                  <Alert
                    variant="warning"
                    title="Ky libër ka nevojë për një çmim para se ta publikoni."
                    className="mt-4"
                  >
                    <p>
                      Vendosni çmimin në lekë më sipër (0 për e-libër falas) dhe ruani
                      ndryshimet.
                    </p>
                  </Alert>
                ) : readiness.missingDescription ? (
                  // FIX1 (X16): Renato's rule, a description before
                  // Publish. Checked after the price, as performPublish()
                  // does; the second W-B sentence is left out here
                  // because this book already is a draft.
                  <Alert
                    variant="warning"
                    title="Shtoni një përshkrim para publikimit."
                    className="mt-4"
                  />
                ) : rightsState.kind === "unavailable" ||
                  takedown.state.kind === "unavailable" ||
                  reviewState.kind === "unavailable" ? (
                  // F4 (D3): the rights choice cannot be read, so
                  // Publish is refused; the existing generic sentence.
                  <Alert variant="warning" title={PUBLISH_NOT_POSSIBLE_YET_MESSAGE} className="mt-4" />
                ) : readiness.missingRights ? (
                  // F4 (P4): after the description, as performPublish()
                  // checks it.
                  <Alert variant="warning" title="Zgjidhni të drejtat para publikimit." className="mt-4" />
                ) : readiness.paidPublishingBlocked ? (
                  <Alert
                    variant="warning"
                    title="Publikimi me pagesë nuk ka nisur ende."
                    className="mt-4"
                  >
                    <p>Librat falas mund t&apos;i publikoni që tani.</p>
                  </Alert>
                ) : (
                  <p className="mt-4 text-sm text-muted">
                    {approvalValid ? "Gati për publikim." : "Gati për t'u dërguar për shqyrtim. Librum e kontrollon çdo libër para se të publikohet."}
                  </p>
                )}

                {readiness.recommended.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Të rekomanduara para publikimit
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
                    disabled={
                      readiness.missingAllPrice ||
                      readiness.missingDescription ||
                      readiness.missingRights ||
                      readiness.paidPublishingBlocked ||
                      takedown.state.kind === "unavailable" ||
                      reviewState.kind === "unavailable"
                    }
                    className={buttonClasses(
                      "primary",
                      "md",
                      "w-full disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    {publishControlLabel(approvalValid)}
                  </button>
                </form>
              </>
            ) : (
              <>
                <p className="mt-4 text-sm text-muted">
                  E heq nga Libraria. Lexuesit që e kanë tashmë
                  e mbajnë shkarkimin e tyre.
                </p>
                <form action={unpublishBook.bind(null, book.id)} className="mt-4">
                  <button type="submit" className={buttonClasses("outline", "md", "w-full")}>
                    Hiqeni nga publikimi
                  </button>
                </form>
              </>
            )}
          </section>

          <section className="rounded-card border border-dashed border-border p-4">
            <h2 className="font-serif text-sm font-normal text-muted">Zona e rrezikut</h2>
            <p className="mt-1 text-xs text-muted">Ky veprim nuk mund të zhbëhet.</p>
            <form action={deleteBook.bind(null, book.id)} className="mt-3">
              <DeleteBookButton title={book.title} />
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
