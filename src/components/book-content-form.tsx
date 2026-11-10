import { CoverField } from "@/components/cover-field";
import { ManuscriptField } from "@/components/manuscript-field";
import { CheckedBookField } from "@/components/checked-book-field";
import { BookSampleReader } from "@/components/book-sample-reader";
import {
  EDITOR_CONTROL_CLASSES,
  EDITOR_FIELD_CLASSES,
  EDITOR_LABEL_CLASSES,
  EDITOR_SMALL_BUTTON,
  EditorActionBar,
  EditorSection,
  Optional,
} from "@/components/book-editor-ui";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import {
  AI_QUESTION,
  AI_STAFF_ONLY_NOTE,
  CONTENT_MISSING_AI,
  CONTENT_MISSING_COVER,
  CONTENT_MISSING_MANUSCRIPT,
  DRM_FREE_NOTE,
  LIVE_SAVE_BUTTON,
  MISSING_FOR_SEND_MESSAGE,
} from "@/lib/book-editor-copy";
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

// D1 (mockup v5): the editor's shared section look and action bar
// (book-editor-ui.tsx). "← Të dhënat" saves first, then goes back.

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
  live = false,
  markMissing = [],
}: {
  action: (formData: FormData) => void | Promise<void>;
  // Upload notes 2 (Enkelejd 11-06): opened from the Pricing tab's to-do
  // list -- the boxes of what is still missing for the send are red.
  markMissing?: string[];
  // BD15 P5b-2: a live book -- a new manuscript or ballinë waits for
  // Librum's review; the save button says so.
  live?: boolean;
  book: ContentFormBook;
  authorId: string;
  // The book's byline (its pen name), for the ebook Librum makes from Word.
  authorName: string;
  aiAnswer: AiAnswer | null;
  // The stored answer could not be read: nothing is pre-ticked, and
  // leaving both unticked keeps whatever is stored.
  aiUnreadable: boolean;
}) {
  const invalid = (label: string) => (markMissing.includes(label) ? MISSING_FOR_SEND_MESSAGE : undefined);
  return (
    <form action={action} className="mt-2 flex flex-col gap-2">
      <UnsavedChangesGuard />
      <EditorSection
        id="content-manuscript"
        title="Dorëshkrimi"
        invalid={invalid(CONTENT_MISSING_MANUSCRIPT)}
        help="DOCX ose EPUB, deri në 50 MB. Skedarin Word e kthejmë ne në libër elektronik dhe ju tregojmë çfarë duhet parë. Një skedar i ri zëvendëson të mëparshmin."
      >
        <p className="text-sm font-semibold">{book.hasManuscript ? "Dorëshkrimi aktual: skedar EPUB" : "Nuk ka dorëshkrim ende"}</p>
        <ManuscriptField
          bookTitle={book.title}
          bookLanguage={book.language ?? undefined}
          authorName={authorName}
          authorId={authorId}
        />
        <p className="text-[13px] text-muted">{DRM_FREE_NOTE}</p>
      </EditorSection>

      <EditorSection id="content-cover" title="Ballina" invalid={invalid(CONTENT_MISSING_COVER)}>
        <CoverField authorId={authorId} existingCoverUrl={book.coverUrl ?? undefined} />
      </EditorSection>

      <EditorSection
        id="content-preview"
        title="Pamja paraprake"
        help={
          book.hasManuscript
            ? "Pamja paraprake tregon gjithë librin si në telefon, tablet ose lexues elektronik, me shenjën ku mbaron pjesa që lexuesit shohin para se ta blejnë."
            : "Ruajeni dorëshkrimin një herë, pastaj e shihni këtu."
        }
      >
        {book.hasManuscript && (
          <div className="flex flex-wrap gap-3">
            <BookSampleReader
              bookId={book.id}
              bookTitle={book.title}
              label="Hap pamjen paraprake"
              mode="full"
              coverUrl={book.coverUrl ?? null}
            />
            {/* A plain link: the route checks the session and that this is the author's own book.
                download: the page stays, so the unsaved-changes guard does not ask (upload notes 1). */}
            <a href={`/api/books/${book.id}/download`} download className={EDITOR_SMALL_BUTTON}>
              Shkarko skedarin tim
            </a>
          </div>
        )}
      </EditorSection>

      <EditorSection id="content-ai" title="AI" help={AI_STAFF_ONLY_NOTE} invalid={invalid(CONTENT_MISSING_AI)}>
        <fieldset className="m-0 flex flex-col border-0 p-0">
          <legend className={EDITOR_LABEL_CLASSES}>{AI_QUESTION}</legend>
          <div className="mt-1.5 flex gap-7">
            {(
              [
                ["no", "Jo"],
                ["yes", "Po"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm sm:min-h-6">
                <input
                  type="radio"
                  name="aiUsed"
                  value={value}
                  defaultChecked={!aiUnreadable && aiAnswer === value}
                  className="focus-ring h-[18px] w-[18px] accent-primary"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </EditorSection>

      <EditorSection id="content-isbn" title="ISBN dhe botuesi" help="Nuk ju duhet ISBN për të botuar në Librum.">
        <label className={`${EDITOR_FIELD_CLASSES} max-w-80`}>
          <span className={EDITOR_LABEL_CLASSES}>
            ISBN
            <Optional />
          </span>
          <CheckedBookField
            kind="isbn"
            id="content-isbn-input"
            name="isbn"
            defaultValue={book.isbn ?? ""}
            placeholder="p.sh. 978-3-16-148410-0"
            className={EDITOR_CONTROL_CLASSES}
          />
        </label>
        <label className={EDITOR_FIELD_CLASSES}>
          <span className={EDITOR_LABEL_CLASSES}>
            Botuesi / shtëpia botuese
            <Optional />
          </span>
          <input
            name="publisher"
            type="text"
            defaultValue={book.publisher ?? ""}
            maxLength={200}
            className={EDITOR_CONTROL_CLASSES}
          />
        </label>
      </EditorSection>

      <EditorActionBar
        backLabel="Të dhënat"
        primaryLabel="Ruaj dhe vazhdo"
        primaryIntent="next"
        primaryNote="Hapi tjetër: Çmimi"
        saveLabel={live ? LIVE_SAVE_BUTTON : undefined}
      />
    </form>
  );
}
