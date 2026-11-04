import { CoverField } from "@/components/cover-field";
import { ManuscriptField } from "@/components/manuscript-field";
import { CheckedBookField } from "@/components/checked-book-field";
import { BookSampleReader } from "@/components/book-sample-reader";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { AI_QUESTION, AI_STAFF_ONLY_NOTE, DRM_FREE_NOTE } from "@/lib/book-editor-copy";
import type { AiAnswer } from "@/lib/book-ai-disclosure";

// BD15 P3: the new editor's Content tab (PLAN-BD15-r1 §2.4; mockup
// "Përmbajtja"). A server component: the manuscript and cover pickers
// are the same client fields the edit page uses (direct upload to the
// author's private temporary folder, the Word converter with its
// warnings and the W4 preview confirmation), so this form only lays
// them out and posts to saveBookContent.
//
// Preview and own download (Renato 11-04, Q2 a): "Hap pamjen paraprake"
// opens the same reader as the public sample -- exactly what readers see
// before buying -- on the author's current file; "Shkarko skedarin tim"
// is the existing download route, which serves an author their own
// current file and records nothing for them.

const SECTION_CLASSES = "flex flex-col gap-3 rounded-[4px] border border-border bg-surface p-5 sm:p-6";

export type ContentFormBook = {
  id: string;
  title: string;
  language: string | null;
  isbn: string | null;
  publisher: string | null;
  hasManuscript: boolean;
  coverUrl: string | null;
};

export function BookContentForm({
  action,
  book,
  authorId,
  authorName,
  aiAnswer,
  aiUnreadable,
}: {
  action: (formData: FormData) => void | Promise<void>;
  book: ContentFormBook;
  authorId: string;
  // The book's byline (its pen name), for the ebook Librum makes from Word.
  authorName: string;
  aiAnswer: AiAnswer | null;
  // The stored answer could not be read: nothing is pre-ticked, and
  // leaving both unticked keeps whatever is stored.
  aiUnreadable: boolean;
}) {
  return (
    <form action={action} className="mt-8 flex flex-col gap-6">
      <section className={SECTION_CLASSES} aria-labelledby="content-manuscript">
        <h2 id="content-manuscript" className="font-serif text-xl font-normal">
          Dorëshkrimi
        </h2>
        <p className="text-sm text-muted">
          DOCX ose EPUB, deri në 50 MB. Skedarin Word e kthejmë ne në libër elektronik dhe ju tregojmë çfarë duhet
          parë. Një skedar i ri zëvendëson të mëparshmin.
        </p>
        <p className="text-sm font-medium">{book.hasManuscript ? "Dorëshkrimi aktual: skedar EPUB" : "Nuk ka dorëshkrim ende"}</p>
        <ManuscriptField
          bookTitle={book.title}
          bookLanguage={book.language ?? undefined}
          authorName={authorName}
          authorId={authorId}
        />
        <p className="text-sm text-muted">{DRM_FREE_NOTE}</p>
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="content-cover">
        <h2 id="content-cover" className="font-serif text-xl font-normal">
          Kopertina
        </h2>
        <CoverField authorId={authorId} existingCoverUrl={book.coverUrl ?? undefined} />
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="content-preview">
        <h2 id="content-preview" className="font-serif text-xl font-normal">
          Pamja paraprake
        </h2>
        {book.hasManuscript ? (
          <>
            <p className="text-sm text-muted">
              Pamja paraprake tregon pjesën që lexuesit shohin para se ta blejnë librin. Për të parë gjithë librin,
              shkarkoni skedarin dhe hapeni në aplikacionin tuaj të leximit.
            </p>
            <div className="flex flex-wrap gap-3">
              <BookSampleReader bookId={book.id} bookTitle={book.title} label="Hap pamjen paraprake" />
              {/* A plain link: the route checks the session and that this is the author's own book. */}
              <a href={`/api/books/${book.id}/download`} className={buttonClasses("outline", "md")}>
                Shkarko skedarin tim
              </a>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">Ruajeni dorëshkrimin një herë, pastaj e shihni këtu.</p>
        )}
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="content-ai">
        <h2 id="content-ai" className="font-serif text-xl font-normal">
          AI
        </h2>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-foreground">{AI_QUESTION}</legend>
          <div className="mt-2 flex gap-6">
            {(
              [
                ["no", "Jo"],
                ["yes", "Po"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="aiUsed"
                  value={value}
                  defaultChecked={!aiUnreadable && aiAnswer === value}
                  className="focus-ring h-5 w-5 accent-primary"
                />
                {label}
              </label>
            ))}
          </div>
          <p className="text-sm text-muted">{AI_STAFF_ONLY_NOTE}</p>
        </fieldset>
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="content-isbn">
        <h2 id="content-isbn" className="font-serif text-xl font-normal">
          ISBN dhe botuesi
        </h2>
        <p className="text-sm text-muted">Opsionale. Nuk ju duhet ISBN për të botuar në Librum.</p>
        <label className="flex flex-col gap-1 text-sm">
          ISBN (opsional)
          <CheckedBookField
            kind="isbn"
            id="content-isbn-input"
            name="isbn"
            defaultValue={book.isbn ?? ""}
            placeholder="p.sh. 978-3-16-148410-0"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Botuesi / shtëpia botuese (opsional)
          <input
            name="publisher"
            type="text"
            defaultValue={book.publisher ?? ""}
            maxLength={200}
            className={formControlClasses}
          />
        </label>
      </section>

      <div className="flex flex-wrap justify-end gap-3">
        <button type="submit" name="intent" value="save" className={buttonClasses("outline", "md", "min-h-11 rounded-full")}>
          Ruaj draftin
        </button>
        <button type="submit" name="intent" value="next" className={buttonClasses("primary", "md", "min-h-11 rounded-full")}>
          Ruaj dhe vazhdo →
        </button>
      </div>
    </form>
  );
}
