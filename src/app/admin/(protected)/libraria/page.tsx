import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { GENRES } from "@/lib/genres";
import { MAX_CATEGORY_BUTTONS } from "@/lib/libraria-store";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { saveCategoryButtons } from "./actions";
import { deleteBannerSlide, moveBannerSlide, saveBannerSlide } from "./banner-actions";
import { deleteReadingPick, saveReadingPick } from "./pick-actions";
import { SlideSaveButton } from "./slide-save-button";
import {
  DEFAULT_PICK_BADGE,
  MAX_PICK_BADGE,
  MAX_PICK_NOTE,
  MAX_PICK_QUOTE,
  PICK_STATUS_LABELS,
  pickMonthLabel,
  pickStatuses,
  type PickRow,
  type PickStatus,
} from "@/lib/libraria-picks";
import { resolveStaffByline } from "@/lib/book-byline";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { LISTED_BOOK_STATUSES } from "@/lib/preorder-reader";
import {
  MAX_SHOWING_SLIDES,
  MAX_SLIDE_DESCRIPTION,
  MAX_SLIDE_TAG,
  SLIDE_STATUS_LABELS,
  slideDaysLabel,
  slideStatus,
  tiranaToday,
  type SlideRow,
  type SlideStatus,
} from "@/lib/libraria-banner";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";

export const metadata: Metadata = {
  title: "Libraria",
};

// LR1 patch 2 (lb5 a, lr2-3 a, lr2-4 b, lr2-5 b): staff (catalog.feature:
// owner and admin) choose up to 6 category buttons for Libraria's "Më
// të rinjtë në Librum" shelf, in order. Each chosen category shows even
// while it has no book. With none chosen the page shows the first 4
// categories with books, A–Zh.
const LOAD_ERROR = "Couldn’t load the category buttons. Please reload the page.";

// LR1 patch 3 (lr1-2, lr3-1 to lr3-9): the banner slides, above the
// category buttons. Staff (catalog.feature) see every slide with what it
// does today, move it up or down, edit or delete it, and add one. The
// book list holds every book Libraria lists (published or pre-order,
// priced: lr3-8 a), A–Zh by title. A slide whose book is not listed now
// shows "Book not live" and hides by itself (lr3-5 a).
const SLIDES_LOAD_ERROR = "Couldn’t load the banner slides. Please reload the page.";
const BOOK_LIST_LIMIT = 500;

type PickableBook = Pick<PublicBook, "id" | "title" | "status" | "cover_path" | "original_author"> & {
  pen: PenNameRef | null;
};

const STATUS_CLASSES: Record<SlideStatus, string> = {
  showing: "bg-[#dceedf] text-[#1d5a2e]",
  waiting: "bg-[#fbe9c8] text-[#7a4b00]",
  ended: "bg-[#e9e6dd] text-[#5c6660]",
  book_not_live: "bg-[#f6dad6] text-[#8a2418]",
};

// LR1 patch 4 (lb2 a, lb6 a, lb8 a, lr4-1 a to lr4-4 a): the "Çfarë po
// lexojmë" picks, between the banner and the category buttons. Staff
// (catalog.feature) see every pick, newest first, with what it does now
// (on Libraria, past, or hidden while its book is not on Libraria:
// lr4-3 a), edit or delete it, and publish a new one, which becomes the
// pick on Libraria (lr4-1 a). The badge starts as "Zgjedhja e Librum"
// (lr4-4 a). Same book list as the slides.
const PICKS_LOAD_ERROR = "Couldn’t load the reading picks. Please reload the page.";

const PICK_STATUS_CLASSES: Record<PickStatus, string> = {
  showing: "bg-[#dceedf] text-[#1d5a2e]",
  past: "bg-[#e9e6dd] text-[#5c6660]",
  book_not_live: "bg-[#f6dad6] text-[#8a2418]",
};

const SMALL_BUTTON = buttonClasses("outline", "md", "min-h-11 rounded-full px-4");

export default async function AdminLibrariaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; edit?: string; pick?: string }>;
}) {
  const { userId } = await requireStaff("catalog.feature");
  const { error: rawError, success: rawSuccess, edit: rawEdit, pick: rawPick } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);

  const supabase = await createClient();
  const { data, error: readError } = await supabase
    .from("libraria_category_buttons")
    .select("position, category")
    .order("position", { ascending: true })
    .returns<{ position: number; category: string }[]>();
  if (readError) console.error("Admin Libraria: failed to load the category buttons:", readError);
  const chosen = (data ?? []).map((r) => r.category);

  const [slidesRead, booksRead, picksRead] = await Promise.all([
    supabase
      .from("libraria_banner_slides")
      .select("id, position, book_id, description, tag, image_path, phone_image_path, starts_on, ends_on")
      .order("position", { ascending: true })
      .returns<SlideRow[]>(),
    supabase
      .from("public_books")
      .select("id, title, status, cover_path, original_author, pen:public_pen_names(id, name)")
      .in("status", LISTED_BOOK_STATUSES)
      .not("price_all", "is", null)
      .order("title", { ascending: true })
      .limit(BOOK_LIST_LIMIT)
      .returns<PickableBook[]>(),
    supabase
      .from("libraria_reading_picks")
      .select("id, book_id, badge, note, quote, quote_from, published_at")
      .order("published_at", { ascending: false })
      .order("id", { ascending: false })
      .returns<PickRow[]>(),
  ]);
  if (picksRead.error) console.error("Admin Libraria: failed to load the reading picks:", picksRead.error);
  const picks = picksRead.data ?? [];
  if (slidesRead.error) console.error("Admin Libraria: failed to load the banner slides:", slidesRead.error);
  if (booksRead.error) console.error("Admin Libraria: failed to load the books:", booksRead.error);
  const slides = slidesRead.data ?? [];
  const books = booksRead.data ?? [];
  const bookById = new Map(books.map((b) => [b.id, b]));
  const today = tiranaToday();
  const pickStatus = pickStatuses(picks, (id) => bookById.has(id));
  const editingPick = typeof rawPick === "string" ? (picks.find((p) => p.id === rawPick) ?? null) : null;
  const editing = typeof rawEdit === "string" ? (slides.find((sl) => sl.id === rawEdit) ?? null) : null;
  const picture = (path: string) => supabase.storage.from("libraria").getPublicUrl(path).data.publicUrl;
  const cover = (path: string | null) => (path ? supabase.storage.from("covers").getPublicUrl(path).data.publicUrl : null);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to admin
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Libraria</h1>

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

      <section className="mt-6" aria-labelledby="banner-slides">
        <h2 id="banner-slides" className="scroll-mt-6 font-serif text-xl font-semibold">
          Banner slides
        </h2>
        <p className="mt-1 text-sm text-muted">
          The banner at the top of Libraria, in this order. Up to {MAX_SHOWING_SLIDES} slides can show on the same
          day. A slide hides by itself outside its days, and while its book is not on Libraria. With no slides
          showing, there is no banner.
        </p>
        {slidesRead.error || booksRead.error ? (
          <Alert variant="error" className="mt-3">
            {SLIDES_LOAD_ERROR}
          </Alert>
        ) : (
          <>
            {slides.length === 0 ? (
              <p className="mt-3 rounded-card border border-border bg-surface p-4 text-sm text-muted">
                No slides yet: Libraria shows no banner.
              </p>
            ) : (
              <ol className="mt-3 flex flex-col gap-3">
                {slides.map((slide, i) => {
                  const book = bookById.get(slide.book_id) ?? null;
                  const status = slideStatus(slide, book !== null, today);
                  return (
                    <li
                      key={slide.id}
                      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-sm sm:flex-row sm:items-center"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={picture(slide.image_path)}
                        alt=""
                        loading="lazy"
                        className="aspect-[15/4] w-full rounded-[6px] object-cover sm:w-48"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted">Slide {i + 1}</p>
                        <p className="font-medium break-words">
                          {book ? book.title : "A book that is not on Libraria now"}
                        </p>
                        <p className="text-sm break-words text-muted">{slide.description}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_CLASSES[status]}`}>
                            {SLIDE_STATUS_LABELS[status]}
                          </span>
                          <span>{slideDaysLabel(slide)}</span>
                          {slide.tag && <span>Tag: {slide.tag}</span>}
                          {slide.phone_image_path && <span>Phone picture</span>}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <form action={moveBannerSlide}>
                          <input type="hidden" name="slideId" value={slide.id} />
                          <input type="hidden" name="direction" value="up" />
                          <button
                            type="submit"
                            disabled={i === 0}
                            aria-label={`Move slide ${i + 1} up`}
                            className={`${SMALL_BUTTON} disabled:opacity-40`}
                          >
                            ↑
                          </button>
                        </form>
                        <form action={moveBannerSlide}>
                          <input type="hidden" name="slideId" value={slide.id} />
                          <input type="hidden" name="direction" value="down" />
                          <button
                            type="submit"
                            disabled={i === slides.length - 1}
                            aria-label={`Move slide ${i + 1} down`}
                            className={`${SMALL_BUTTON} disabled:opacity-40`}
                          >
                            ↓
                          </button>
                        </form>
                        <Link href={`/admin/libraria?edit=${slide.id}#banner-form`} className={SMALL_BUTTON}>
                          Edit
                        </Link>
                        <form action={deleteBannerSlide}>
                          <input type="hidden" name="slideId" value={slide.id} />
                          <button type="submit" aria-label={`Delete slide ${i + 1}`} className={SMALL_BUTTON}>
                            Delete
                          </button>
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            {/* A fresh form per slide: Edit opens without a reload, and a
                book list keeps what it showed before (bug 2026-11-26). */}
            <SlideForm key={editing?.id ?? "new"} slide={editing} books={books} cover={cover} staffUserId={userId} />
          </>
        )}
      </section>

      <section className="mt-10" aria-labelledby="reading-picks">
        <h2 id="reading-picks" className="scroll-mt-6 font-serif text-xl font-semibold">
          Çfarë po lexojmë
        </h2>
        <p className="mt-1 text-sm text-muted">
          The box under “Libra që i gjeni vetëm në Librum”. The newest pick shows on Libraria; the others are on its
          “Më shumë” page, newest first. A pick hides while its book is not on Libraria, and the newest pick that is
          on Libraria shows instead. With no picks, there is no box.
        </p>
        {picksRead.error || booksRead.error ? (
          <Alert variant="error" className="mt-3">
            {PICKS_LOAD_ERROR}
          </Alert>
        ) : (
          <>
            {picks.length === 0 ? (
              <p className="mt-3 rounded-card border border-border bg-surface p-4 text-sm text-muted">
                No picks yet: Libraria shows no “Çfarë po lexojmë” box.
              </p>
            ) : (
              <ol className="mt-3 flex flex-col gap-3">
                {picks.map((pick) => {
                  const book = bookById.get(pick.book_id) ?? null;
                  const status = pickStatus.get(pick.id) ?? "past";
                  const bookCover = book ? cover(book.cover_path) : null;
                  return (
                    <li
                      key={pick.id}
                      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-sm sm:flex-row sm:items-center"
                    >
                      {book &&
                        (bookCover ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={bookCover}
                            alt=""
                            loading="lazy"
                            className="aspect-[5/8] w-12 shrink-0 rounded-[2px] object-contain object-bottom"
                          />
                        ) : (
                          <CoverPlaceholder
                            title={book.title}
                            authorName={resolveStaffByline(book)}
                            className="aspect-[5/8] w-12 shrink-0 rounded-[2px]"
                          />
                        ))}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted">{pickMonthLabel(pick.published_at)}</p>
                        <p className="font-medium break-words">
                          {book ? book.title : "A book that is not on Libraria now"}
                        </p>
                        <p className="line-clamp-2 text-sm break-words text-muted">{pick.note}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <span className={`rounded-full px-2 py-0.5 font-semibold ${PICK_STATUS_CLASSES[status]}`}>
                            {PICK_STATUS_LABELS[status]}
                          </span>
                          <span>{pick.badge ? `Badge: ${pick.badge}` : "No badge"}</span>
                          <span>Quote from the {pick.quote_from === "book" ? "book" : "author"}</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/admin/libraria?pick=${pick.id}#pick-form`} className={SMALL_BUTTON}>
                          Edit
                        </Link>
                        <form action={deleteReadingPick}>
                          <input type="hidden" name="pickId" value={pick.id} />
                          <button
                            type="submit"
                            aria-label={`Delete the pick ${book ? book.title : ""}`.trim()}
                            className={SMALL_BUTTON}
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            <PickForm key={editingPick?.id ?? "new"} pick={editingPick} books={books} />
          </>
        )}
      </section>

      <section className="mt-10" aria-labelledby="category-buttons">
        <h2 id="category-buttons" className="font-serif text-xl font-semibold">
          Category buttons
        </h2>
        <p className="mt-1 text-sm text-muted">
          Up to {MAX_CATEGORY_BUTTONS} buttons under “Më të rinjtë në Librum”, in this order. Leave all empty to show
          the first 4 categories with books, A–Zh.
        </p>
        {readError ? (
          <Alert variant="error" className="mt-3">
            {LOAD_ERROR}
          </Alert>
        ) : (
          <form action={saveCategoryButtons} className="mt-4 flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5">
            <ol className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: MAX_CATEGORY_BUTTONS }, (_, i) => (
                <li key={i}>
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    Button {i + 1}
                    <select
                      name={`slot${i + 1}`}
                      defaultValue={chosen[i] ?? ""}
                      className={`${formControlClasses} min-h-11`}
                    >
                      <option value="">None</option>
                      {GENRES.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
            </ol>
            <div>
              <button type="submit" className={buttonClasses("primary", "md", "min-h-11 rounded-full px-5")}>
                Save
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

// Add a slide, or edit one (?edit=<id>). The book's title, cover and
// link go on the slide by themselves (lr3-1 a, lr1-2c a).
function SlideForm({
  slide,
  books,
  cover,
  staffUserId,
}: {
  slide: SlideRow | null;
  books: PickableBook[];
  cover: (path: string | null) => string | null;
  staffUserId: string;
}) {
  const chosen = slide ? (books.find((b) => b.id === slide.book_id) ?? null) : null;
  const chosenAuthor = chosen ? resolveStaffByline(chosen) : null;
  const chosenCover = chosen ? cover(chosen.cover_path) : null;
  return (
    <form
      id="banner-form"
      action={saveBannerSlide}
      className="mt-4 flex scroll-mt-6 flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5"
    >
      <h3 className="font-serif text-lg font-semibold">{slide ? "Edit slide" : "Add a slide"}</h3>
      {slide && <input type="hidden" name="slideId" value={slide.id} />}

      <label className="flex flex-col gap-1 text-sm font-medium">
        Book
        <select name="bookId" required defaultValue={slide?.book_id ?? ""} className={`${formControlClasses} min-h-11`}>
          <option value="" disabled>
            Choose a book
          </option>
          {books.map((b) => {
            const author = resolveStaffByline(b);
            return (
              <option key={b.id} value={b.id}>
                {b.title}
                {author ? ` — ${author}` : ""}
                {b.status === "preorder" ? " (pre-order)" : ""}
              </option>
            );
          })}
        </select>
        <span className="text-xs font-normal text-muted">
          Its title, cover and link go on the slide. Published and pre-order books only.
        </span>
      </label>
      {slide && chosen && (
        <div className="flex items-center gap-3 text-sm">
          {chosenCover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={chosenCover} alt="" className="aspect-[5/8] w-10 rounded-[2px] object-contain object-bottom" />
          ) : (
            <CoverPlaceholder title={chosen.title} authorName={chosenAuthor} className="aspect-[5/8] w-10 rounded-[2px]" />
          )}
          <span className="text-muted">Now: {chosen.title}</span>
        </div>
      )}

      <label className="flex flex-col gap-1 text-sm font-medium">
        One-line description
        <input
          type="text"
          name="description"
          required
          maxLength={MAX_SLIDE_DESCRIPTION}
          defaultValue={slide?.description ?? ""}
          className={`${formControlClasses} min-h-11`}
        />
        <span className="text-xs font-normal text-muted">Up to {MAX_SLIDE_DESCRIPTION} characters.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Tag (optional)
        <input
          type="text"
          name="tag"
          maxLength={MAX_SLIDE_TAG}
          defaultValue={slide?.tag ?? ""}
          className={`${formControlClasses} min-h-11 sm:max-w-xs`}
        />
        <span className="text-xs font-normal text-muted">
          A short word on the slide, for example “Ofertë” or “E re”. Up to {MAX_SLIDE_TAG} characters. Empty = no
          tag.
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          First day (optional)
          <input type="date" name="startsOn" defaultValue={slide?.starts_on ?? ""} className={`${formControlClasses} min-h-11`} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Last day (optional)
          <input type="date" name="endsOn" defaultValue={slide?.ends_on ?? ""} className={`${formControlClasses} min-h-11`} />
        </label>
        <p className="text-xs text-muted sm:col-span-2">
          Tirana time. Empty first day = from now; empty last day = until you delete it.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Picture{slide ? " (leave empty to keep it)" : ""}
        <input
          type="file"
          data-slide-picture="wide"
          accept="image/jpeg,image/png"
          required={!slide}
          className="text-sm file:mr-3 file:rounded-full file:border file:border-primary file:bg-transparent file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary"
        />
        <span className="text-xs font-normal text-muted">
          JPG or PNG under 5 MB. Wide: about 2400 × 640 pixels. The left side sits behind the cover and words.
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Phone picture (optional)
        <input
          type="file"
          data-slide-picture="phone"
          accept="image/jpeg,image/png"
          className="text-sm file:mr-3 file:rounded-full file:border file:border-primary file:bg-transparent file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary"
        />
        <span className="text-xs font-normal text-muted">
          About 1200 × 1050 pixels. The bottom sits behind the cover and words. Without it, phones show the middle of
          the wide picture.
        </span>
      </label>
      {slide?.phone_image_path && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="removePhonePicture" className="size-4" />
          Remove the phone picture
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SlideSaveButton
          staffUserId={staffUserId}
          label={slide ? "Save slide" : "Add slide"}
          className={buttonClasses("primary", "md", "min-h-11 rounded-full px-5")}
        />
        {slide && (
          <Link href="/admin/libraria#banner-slides" className="text-sm underline underline-offset-2 hover:decoration-2">
            Cancel
          </Link>
        )}
      </div>
    </form>
  );
}

// Publish a new pick, or edit one (?pick=<id>). The book's cover, title,
// author, stars, price and button go in the box by themselves.
function PickForm({ pick, books }: { pick: PickRow | null; books: PickableBook[] }) {
  return (
    <form
      id="pick-form"
      action={saveReadingPick}
      className="mt-4 flex scroll-mt-6 flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5"
    >
      <h3 className="font-serif text-lg font-semibold">{pick ? "Edit pick" : "Publish a new pick"}</h3>
      {pick && <input type="hidden" name="pickId" value={pick.id} />}

      <label className="flex flex-col gap-1 text-sm font-medium">
        Book
        <select name="bookId" required defaultValue={pick?.book_id ?? ""} className={`${formControlClasses} min-h-11`}>
          <option value="" disabled>
            Choose a book
          </option>
          {books.map((b) => {
            const author = resolveStaffByline(b);
            return (
              <option key={b.id} value={b.id}>
                {b.title}
                {author ? ` — ${author}` : ""}
                {b.status === "preorder" ? " (pre-order)" : ""}
              </option>
            );
          })}
        </select>
        <span className="text-xs font-normal text-muted">
          Its cover, title, author, stars and price go in the box. Published and pre-order books only.
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Badge (optional)
        <input
          type="text"
          name="badge"
          maxLength={MAX_PICK_BADGE}
          defaultValue={pick ? (pick.badge ?? "") : DEFAULT_PICK_BADGE}
          className={`${formControlClasses} min-h-11 sm:max-w-xs`}
        />
        <span className="text-xs font-normal text-muted">Up to {MAX_PICK_BADGE} characters. Empty = no badge.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Why we are reading it
        <textarea
          name="note"
          required
          rows={4}
          maxLength={MAX_PICK_NOTE}
          defaultValue={pick?.note ?? ""}
          className={formControlClasses}
        />
        <span className="text-xs font-normal text-muted">One paragraph, up to {MAX_PICK_NOTE} characters.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Quote
        <textarea
          name="quote"
          required
          rows={3}
          maxLength={MAX_PICK_QUOTE}
          defaultValue={pick?.quote ?? ""}
          className={formControlClasses}
        />
        <span className="text-xs font-normal text-muted">
          One paragraph, up to {MAX_PICK_QUOTE} characters, without quotation marks.
        </span>
      </label>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="font-medium">The quote is from</legend>
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" name="quoteFrom" value="book" required defaultChecked={(pick?.quote_from ?? "book") === "book"} className="size-4" />
          The book (shows “nga” and the book’s title)
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" name="quoteFrom" value="author" defaultChecked={pick?.quote_from === "author"} className="size-4" />
          The author (shows “autori i librit”)
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClasses("primary", "md", "min-h-11 rounded-full px-5")}>
          {pick ? "Save pick" : "Publish pick"}
        </button>
        {pick && (
          <Link href="/admin/libraria#reading-picks" className="text-sm underline underline-offset-2 hover:decoration-2">
            Cancel
          </Link>
        )}
      </div>
    </form>
  );
}
