"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { createSeriesFromEditor } from "@/app/(public)/dashboard/books/editor-actions";
import { GENRES } from "@/lib/genres";
import { LANGUAGES } from "@/lib/languages";
import { CONTRIBUTOR_ROLES, contributorRoleLabel } from "@/lib/contributor-roles";
import { RIGHTS_BASES, RIGHTS_STATEMENTS } from "@/lib/rights-statements";
import { ORIGINAL_AUTHOR_HINT, ORIGINAL_AUTHOR_MAX_LENGTH } from "@/lib/book-byline";
import {
  CHILDREN_CATEGORIES,
  CONTRIBUTOR_NAME_MAX_LENGTH,
  EDITION_NUMBER_MAX,
  MAX_CATEGORIES,
  MAX_CONTRIBUTORS,
  MAX_KEYWORDS,
  READING_AGES,
  SUBTITLE_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  parseBookDetails,
  splitKeywords,
  type DetailsField,
} from "@/lib/book-details";
import {
  LIVE_REVIEW_FIELD_HINT,
  LIVE_RIGHTS_LOCKED_NOTE,
  LIVE_SAVE_BUTTON,
  PEN_NAME_LOCKED_NOTE,
  TITLE_LOCKED_NOTE,
  TITLE_WILL_LOCK_NOTE,
} from "@/lib/book-editor-copy";
import { fieldErrorClasses } from "@/lib/form-styles";
import {
  EDITOR_FIELD_CLASSES,
  EDITOR_HINT_CLASSES,
  EDITOR_LABEL_CLASSES,
  EDITOR_LINK_BUTTON,
  EDITOR_SMALL_BUTTON,
  EditorActionBar,
  EditorSection,
  Optional,
  editorControlClassesFor,
} from "@/components/book-editor-ui";
import { DescriptionEditor } from "@/components/description-editor";
import type { RightsBasis } from "@/lib/types";

// BD15 P2: the Details tab ("Të dhënat") of the new book editor
// (PLAN-BD15-r1 §2.3). One form; "Ruaj draftin" saves and stays,
// "Ruaj dhe vazhdo" saves and opens the next tab. The browser checks the
// rules of src/lib/book-details.ts first; the server checks them again.

export type DetailsFormValues = {
  title: string;
  subtitle: string;
  language: string;
  seriesId: string;
  seriesPosition: string;
  editionNumber: string;
  penNameId: string;
  description: string;
  isAdult: boolean;
  readingAge: string;
  categories: string[];
  keywords: string;
  contributors: { id: string; name: string; role: string }[];
  rightsBasis: RightsBasis | "";
  originalAuthor: string;
};

export type EditorPenName = { id: string; name: string; is_default: boolean };
export type EditorSeries = { id: string; title: string; pen_name_id: string | null };

// D1 (mockup v5): the editor's shared look (book-editor-ui.tsx).
const TEXT_LINK_CLASSES =
  "focus-ring w-fit rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";
const CHOICE_LABEL_CLASSES = "flex min-h-11 cursor-pointer items-center gap-2.5 text-sm sm:min-h-6";
const CHOICE_INPUT_CLASSES = "focus-ring h-[18px] w-[18px] shrink-0 accent-primary";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span id={id} className={fieldErrorClasses}>
      {message}
    </span>
  );
}

function Section({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  const id = `details-section-${title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z]+/g, "-")
    .toLowerCase()}`;
  return (
    <EditorSection id={id} title={title} help={lead}>
      {children}
    </EditorSection>
  );
}

export function BookDetailsForm({
  action,
  initial,
  locked,
  rightsLocked = false,
  live = false,
  lockedPenName,
  penNames,
  series: initialSeries,
  pdFrozen = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  initial: DetailsFormValues;
  // The book has been published once: title and pen name are fixed.
  locked: boolean;
  // BD15 P5b-2 (Renato 11-04, Q4 a): a live book's rights basis is fixed.
  rightsLocked?: boolean;
  // BD15 P5b-2: a live book -- the description, 18+ label and original
  // author wait for Librum's review; the save button says so.
  live?: boolean;
  lockedPenName: string | null;
  penNames: EditorPenName[];
  series: EditorSeries[];
  // BD15 follow-up (P7 audit N5): a picked public-domain edition. Its
  // frozen details (language, subtitle, contributors, series, edition,
  // reading age, categories, keywords) show greyed and can't be changed;
  // hidden copies send the stored values, so a save still goes through
  // pdFrozenDetailsUnchanged on the server as before.
  pdFrozen?: boolean;
}) {
  const [errors, setErrors] = useState<Partial<Record<DetailsField, string>>>({});
  const [penNameId, setPenNameId] = useState(initial.penNameId);
  const [seriesList, setSeriesList] = useState(initialSeries);
  const [seriesId, setSeriesId] = useState(initial.seriesId);
  const [newSeriesOpen, setNewSeriesOpen] = useState(false);
  const [newSeriesTitle, setNewSeriesTitle] = useState("");
  const [newSeriesMessage, setNewSeriesMessage] = useState("");
  const [newSeriesBusy, setNewSeriesBusy] = useState(false);
  const [contributors, setContributors] = useState(initial.contributors);
  const [isAdult, setIsAdult] = useState(initial.isAdult);
  const [readingAge, setReadingAge] = useState(initial.readingAge);
  const [categories, setCategories] = useState<string[]>(initial.categories);
  const [keywords, setKeywords] = useState(initial.keywords);
  const [rightsBasis, setRightsBasis] = useState<RightsBasis | "">(initial.rightsBasis);
  const formRef = useRef<HTMLFormElement>(null);

  // A series carries one pen name: only the chosen pen name's series
  // are offered (the database refuses a mix, LB451).
  const seriesForPenName = seriesList.filter((s) => !s.pen_name_id || s.pen_name_id === penNameId);
  const keywordCount = splitKeywords(keywords).length;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const result = parseBookDetails(new FormData(form));
    if (!result.ok) {
      event.preventDefault();
      setErrors(result.errors);
      const first = Object.keys(result.errors)[0];
      const target = form.querySelector<HTMLElement>(`[data-field="${first}"]`);
      target?.focus();
      return;
    }
    setErrors({});
  };

  const toggleCategory = (category: string, checked: boolean) => {
    setCategories((current) =>
      checked ? (current.includes(category) ? current : [...current, category]) : current.filter((c) => c !== category),
    );
  };

  const createSeries = async () => {
    setNewSeriesBusy(true);
    setNewSeriesMessage("");
    try {
      const result = await createSeriesFromEditor(newSeriesTitle, penNameId);
      if (!result.ok) {
        setNewSeriesMessage(result.message);
        return;
      }
      setSeriesList((list) => [...list, result.series]);
      setSeriesId(result.series.id);
      setNewSeriesOpen(false);
      setNewSeriesTitle("");
    } catch {
      setNewSeriesMessage("Seria nuk u krijua dot. Provoni përsëri.");
    } finally {
      setNewSeriesBusy(false);
    }
  };

  const err = (field: DetailsField) => errors[field];
  const describe = (field: DetailsField, hint?: string) =>
    [errors[field] ? `details-${field}-error` : null, hint ?? null].filter(Boolean).join(" ") || undefined;

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="mt-2 flex flex-col gap-2">
      <Section title="Gjuha" lead="Gjuha në të cilën është shkruar libri.">
        <label className={`${EDITOR_FIELD_CLASSES} max-w-80`}>
          <span className={EDITOR_LABEL_CLASSES}>Gjuha</span>
          <select
            name="language"
            data-field="language"
            defaultValue={initial.language || "sq"}
            disabled={pdFrozen}
            aria-describedby={describe("language")}
            className={editorControlClassesFor(!!err("language"))}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <FieldError id="details-language-error" message={err("language")} />
          {pdFrozen && <input type="hidden" name="language" value={initial.language || "sq"} />}
        </label>
      </Section>

      <Section title="Titulli" lead="Shkruajeni saktësisht si në ballinë.">
        {locked ? (
          <div className={EDITOR_FIELD_CLASSES}>
            <span className={EDITOR_LABEL_CLASSES}>Titulli i librit</span>
            <p className="rounded-md border border-border bg-background px-2.5 py-2 text-base text-muted sm:py-1.5 sm:text-sm">{initial.title}</p>
            <span className={EDITOR_HINT_CLASSES}>{TITLE_LOCKED_NOTE}</span>
            <input type="hidden" name="title" value={initial.title} />
          </div>
        ) : (
          <label className={EDITOR_FIELD_CLASSES}>
            <span className={EDITOR_LABEL_CLASSES}>Titulli i librit</span>
            <input
              name="title"
              data-field="title"
              type="text"
              required
              maxLength={TITLE_MAX_LENGTH}
              defaultValue={initial.title}
              aria-invalid={err("title") ? true : undefined}
              aria-describedby={describe("title", "details-title-hint")}
              className={editorControlClassesFor(!!err("title"))}
            />
            <span id="details-title-hint" className={EDITOR_HINT_CLASSES}>
              {TITLE_WILL_LOCK_NOTE}
            </span>
            <FieldError id="details-title-error" message={err("title")} />
          </label>
        )}
        <label className={EDITOR_FIELD_CLASSES}>
          <span className={EDITOR_LABEL_CLASSES}>
            Nëntitulli
            <Optional />
          </span>
          <input
            name="subtitle"
            data-field="subtitle"
            type="text"
            maxLength={SUBTITLE_MAX_LENGTH}
            defaultValue={initial.subtitle}
            disabled={pdFrozen}
            aria-describedby={describe("subtitle")}
            className={editorControlClassesFor(!!err("subtitle"))}
          />
          <FieldError id="details-subtitle-error" message={err("subtitle")} />
          {pdFrozen && <input type="hidden" name="subtitle" value={initial.subtitle} />}
        </label>
      </Section>

      <Section title="Autori" lead="Emri që shohin lexuesit vjen nga profili juaj.">
        {locked ? (
          <div className={`${EDITOR_FIELD_CLASSES} max-w-80`}>
            <span className={EDITOR_LABEL_CLASSES}>Emri i autorit</span>
            <p className="rounded-md border border-border bg-background px-2.5 py-2 text-base text-muted sm:py-1.5 sm:text-sm">{lockedPenName}</p>
            <span className={EDITOR_HINT_CLASSES}>{PEN_NAME_LOCKED_NOTE}</span>
          </div>
        ) : (
          <label className={`${EDITOR_FIELD_CLASSES} max-w-80`}>
            <span className={EDITOR_LABEL_CLASSES}>Emri i autorit</span>
            <select
              name="penNameId"
              data-field="penNameId"
              value={penNameId}
              onChange={(e) => {
                setPenNameId(e.target.value);
                // A series of another pen name can't hold this book.
                const chosen = seriesList.find((s) => s.id === seriesId);
                if (chosen?.pen_name_id && chosen.pen_name_id !== e.target.value) setSeriesId("");
              }}
              className={editorControlClassesFor(!!err("penNameId"))}
            >
              {penNames.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className={EDITOR_HINT_CLASSES}>
              Shtoni ose ndryshoni emra te{" "}
              <Link href="/dashboard/pen-names" className={TEXT_LINK_CLASSES}>
                Profili → Emrat e autorit
              </Link>
              .
            </span>
          </label>
        )}

        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" data-field="contributors" tabIndex={-1} aria-describedby={describe("contributors")}>
          <legend className={EDITOR_LABEL_CLASSES}>
            Kontribues të tjerë
            <Optional>opsional, deri në {MAX_CONTRIBUTORS}</Optional>
          </legend>
          {contributors.map((c, i) => (
            <div key={c.id || `new-${i}`} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="contributorId" value={c.id} />
              {pdFrozen && (
                <>
                  <input type="hidden" name="contributorRole" value={c.role} />
                  <input type="hidden" name="contributorName" value={c.name} />
                </>
              )}
              <label className={`${EDITOR_FIELD_CLASSES} w-full sm:w-48`}>
                <span className={EDITOR_HINT_CLASSES}>Roli</span>
                <select
                  name="contributorRole"
                  value={c.role}
                  disabled={pdFrozen}
                  onChange={(e) =>
                    setContributors((list) => list.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))
                  }
                  className={editorControlClassesFor(false)}
                >
                  {CONTRIBUTOR_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {contributorRoleLabel(role)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${EDITOR_FIELD_CLASSES} min-w-48 flex-1`}>
                <span className={EDITOR_HINT_CLASSES}>Emri</span>
                <input
                  name="contributorName"
                  type="text"
                  maxLength={CONTRIBUTOR_NAME_MAX_LENGTH}
                  value={c.name}
                  disabled={pdFrozen}
                  onChange={(e) =>
                    setContributors((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                  className={editorControlClassesFor(false)}
                />
              </label>
              {!pdFrozen && (
                <button
                  type="button"
                  onClick={() => setContributors((list) => list.filter((_, j) => j !== i))}
                  className={EDITOR_SMALL_BUTTON}
                >
                  Hiq
                </button>
              )}
            </div>
          ))}
          {pdFrozen ? null : contributors.length < MAX_CONTRIBUTORS ? (
            <button
              type="button"
              onClick={() => setContributors((list) => [...list, { id: "", name: "", role: "Co-Author" }])}
              className={EDITOR_LINK_BUTTON}
            >
              + Shto kontribues
            </button>
          ) : (
            <p className={EDITOR_HINT_CLASSES}>Keni arritur kufirin prej {MAX_CONTRIBUTORS} kontribuesish.</p>
          )}
          <FieldError id="details-contributors-error" message={err("contributors")} />
        </fieldset>
      </Section>

      <Section
        title="Seria"
        lead="Nëse libri është pjesë e një serie, lidheni këtu. Të gjithë librat e një serie dalin me të njëjtin emër autori."
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className={`${EDITOR_FIELD_CLASSES} min-w-56 flex-1`}>
            <span className={EDITOR_LABEL_CLASSES}>
              Seria
              <Optional>opsionale</Optional>
            </span>
            <select
              name="seriesId"
              value={seriesId}
              disabled={pdFrozen}
              onChange={(e) => setSeriesId(e.target.value)}
              className={editorControlClassesFor(false)}
            >
              <option value="">Nuk është pjesë e një serie</option>
              {seriesForPenName.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <label className={`${EDITOR_FIELD_CLASSES} w-32`}>
            <span className={EDITOR_LABEL_CLASSES}>Numri në seri</span>
            <input
              name="seriesPosition"
              data-field="seriesPosition"
              type="text"
              inputMode="numeric"
              disabled={!seriesId || pdFrozen}
              defaultValue={initial.seriesPosition}
              aria-describedby={describe("seriesPosition")}
              className={editorControlClassesFor(!!err("seriesPosition"))}
            />
          </label>
        </div>
        <FieldError id="details-seriesPosition-error" message={err("seriesPosition")} />
        {pdFrozen && (
          <>
            <input type="hidden" name="seriesId" value={seriesId} />
            {seriesId && <input type="hidden" name="seriesPosition" value={initial.seriesPosition} />}
          </>
        )}
        {pdFrozen ? null : !locked || penNameId ? (
          newSeriesOpen ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <label className={EDITOR_FIELD_CLASSES}>
                <span className={EDITOR_LABEL_CLASSES}>Emri i serisë së re</span>
                <input
                  type="text"
                  maxLength={300}
                  value={newSeriesTitle}
                  onChange={(e) => setNewSeriesTitle(e.target.value)}
                  className={editorControlClassesFor(!!newSeriesMessage)}
                />
              </label>
              <p className={EDITOR_HINT_CLASSES}>
                Të gjithë librat e serisë dalin me emrin{" "}
                {penNames.find((p) => p.id === penNameId)?.name ?? lockedPenName ?? ""}.
              </p>
              {newSeriesMessage && <p className={fieldErrorClasses}>{newSeriesMessage}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={newSeriesBusy}
                  onClick={createSeries}
                  className={`${EDITOR_SMALL_BUTTON} border-primary bg-primary text-primary-foreground hover:bg-primary-hover`}
                >
                  Krijo serinë
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewSeriesOpen(false);
                    setNewSeriesMessage("");
                  }}
                  className={EDITOR_LINK_BUTTON}
                >
                  Anulo
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNewSeriesOpen(true)}
              className={EDITOR_LINK_BUTTON}
            >
              + Krijo seri të re
            </button>
          )
        ) : null}
        <p className={EDITOR_HINT_CLASSES}>
          Draftet nuk shfaqen në faqen e serisë. Nëse një libër hiqet nga shitja, vendi i tij mbetet “Nuk është në
          dispozicion” dhe numrat nuk ndryshojnë.
        </p>
      </Section>

      <Section title="Botimi" lead="Përdoreni kur del një botim i ri i të njëjtit libër.">
        <label className={`${EDITOR_FIELD_CLASSES} w-40`}>
          <span className={EDITOR_LABEL_CLASSES}>
            Numri i botimit
            <Optional />
          </span>
          <input
            name="editionNumber"
            data-field="editionNumber"
            type="text"
            inputMode="numeric"
            maxLength={String(EDITION_NUMBER_MAX).length}
            defaultValue={initial.editionNumber}
            disabled={pdFrozen}
            aria-describedby={describe("editionNumber")}
            className={editorControlClassesFor(!!err("editionNumber"))}
          />
        </label>
        <FieldError id="details-editionNumber-error" message={err("editionNumber")} />
        {pdFrozen && <input type="hidden" name="editionNumber" value={initial.editionNumber} />}
      </Section>

      <Section title="Përshkrimi" lead="Ky tekst del në faqen e librit. Shkruajeni për lexuesin.">
        <span id="details-description-label" className={EDITOR_LABEL_CLASSES}>
          Përshkrimi
        </span>
        <div data-field="description" tabIndex={-1}>
          <DescriptionEditor
            name="description"
            initialValue={initial.description}
            labelId="details-description-label"
            describedBy={describe("description")}
            invalid={!!err("description")}
          />
        </div>
        <FieldError id="details-description-error" message={err("description")} />
        {live && <p className={EDITOR_HINT_CLASSES}>{LIVE_REVIEW_FIELD_HINT}</p>}
      </Section>

      <Section title="Të drejtat" lead="Kush i ka të drejtat e këtij teksti?">
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-field="rightsBasis" tabIndex={-1}>
          <legend className="sr-only">Të drejtat</legend>
          {RIGHTS_BASES.map((basis) => (
            <label key={basis} className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="radio"
                name={rightsLocked ? undefined : "rightsBasis"}
                value={basis}
                checked={rightsBasis === basis}
                disabled={rightsLocked}
                onChange={() => setRightsBasis(basis)}
                className={`${CHOICE_INPUT_CLASSES} mt-px`}
              />
              <span>{RIGHTS_STATEMENTS[basis].text}</span>
            </label>
          ))}
          {rightsLocked && (
            <>
              {rightsBasis && <input type="hidden" name="rightsBasis" value={rightsBasis} />}
              <p className={EDITOR_HINT_CLASSES}>{LIVE_RIGHTS_LOCKED_NOTE}</p>
            </>
          )}
          <FieldError id="details-rightsBasis-error" message={err("rightsBasis")} />
        </fieldset>
        <label className={EDITOR_FIELD_CLASSES}>
          <span className={EDITOR_LABEL_CLASSES}>
            Autori origjinal
            {rightsBasis === "public_domain" || rightsBasis === "public_domain_original" ? null : <Optional />}
          </span>
          <input
            name="originalAuthor"
            data-field="originalAuthor"
            type="text"
            maxLength={ORIGINAL_AUTHOR_MAX_LENGTH}
            defaultValue={initial.originalAuthor}
            aria-describedby={describe("originalAuthor", "details-originalAuthor-hint")}
            className={editorControlClassesFor(!!err("originalAuthor"))}
          />
          <span id="details-originalAuthor-hint" className={EDITOR_HINT_CLASSES}>
            {ORIGINAL_AUTHOR_HINT}
            {live && ` ${LIVE_REVIEW_FIELD_HINT}`}
          </span>
          <FieldError id="details-originalAuthor-error" message={err("originalAuthor")} />
        </label>
      </Section>

      <Section title="Lexuesit" lead="Ndihmon prindërit dhe lexuesit të gjejnë librin e duhur.">
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className={EDITOR_LABEL_CLASSES}>A ka përmbajtje vetëm për të rritur (18+)?</legend>
          <div className="mt-1.5 flex gap-7">
            {[
              { value: "no", label: "Jo" },
              { value: "yes", label: "Po" },
            ].map((o) => (
              <label key={o.value} className={CHOICE_LABEL_CLASSES}>
                <input
                  type="radio"
                  name="isAdult"
                  value={o.value}
                  checked={isAdult === (o.value === "yes")}
                  onChange={() => {
                    const adult = o.value === "yes";
                    setIsAdult(adult);
                    // A frozen reading age keeps its stored value underneath.
                    if (adult && !pdFrozen) setReadingAge("18");
                  }}
                  className={CHOICE_INPUT_CLASSES}
                />
                {o.label}
              </label>
            ))}
          </div>
          {isAdult && (
            <p className={EDITOR_HINT_CLASSES}>
              Libri shfaqet si zakonisht, me shënimin “18+” te të dhënat e librit. Nuk mund të jetë te “Për fëmijë” ose
              “Për të rinj”.
            </p>
          )}
          {live && <p className={EDITOR_HINT_CLASSES}>{LIVE_REVIEW_FIELD_HINT}</p>}
        </fieldset>
        <label className={`${EDITOR_FIELD_CLASSES} w-48`}>
          <span className={EDITOR_LABEL_CLASSES}>Mosha e leximit nga</span>
          <select
            name="readingAge"
            data-field="readingAge"
            value={isAdult ? "18" : readingAge}
            disabled={isAdult || pdFrozen}
            onChange={(e) => setReadingAge(e.target.value)}
            aria-describedby={describe("readingAge")}
            className={editorControlClassesFor(!!err("readingAge"))}
          >
            <option value="">Pa caktuar</option>
            {READING_AGES.map((age) => (
              <option key={age} value={String(age)}>
                {age === 18 ? "18+" : `${age} vjeç`}
              </option>
            ))}
          </select>
          {isAdult ? (
            <input type="hidden" name="readingAge" value="18" />
          ) : (
            pdFrozen && <input type="hidden" name="readingAge" value={readingAge} />
          )}
        </label>
        <FieldError id="details-readingAge-error" message={err("readingAge")} />
      </Section>

      <Section title="Kategoritë" lead={`Zgjidhni deri në ${MAX_CATEGORIES}. E para që zgjidhni është kategoria kryesore.`}>
        <fieldset className="m-0 border-0 p-0" data-field="categories" tabIndex={-1} aria-describedby={describe("categories", "details-categories-count")}>
          <legend className="sr-only">Kategoritë</legend>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((genre) => {
              const on = categories.includes(genre);
              const blockedByAdult = isAdult && CHILDREN_CATEGORIES.includes(genre);
              const full = !on && categories.length >= MAX_CATEGORIES;
              return (
                <label
                  key={genre}
                  className={`flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm focus-within:shadow-[var(--focus-ring)] sm:min-h-8 ${
                    pdFrozen
                      ? on
                        ? "cursor-not-allowed border-border bg-background font-semibold text-muted"
                        : "cursor-not-allowed border-border bg-surface text-muted"
                      : on
                      ? "cursor-pointer border-primary bg-primary text-primary-foreground"
                      : blockedByAdult || full
                        ? "cursor-not-allowed border-border bg-surface text-muted"
                        : "cursor-pointer border-control bg-surface hover:bg-surface-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={pdFrozen || (blockedByAdult && !on) || full}
                    onChange={(e) => toggleCategory(genre, e.target.checked)}
                    className="h-4 w-4 shrink-0 accent-accent"
                  />
                  {genre}
                  {categories[0] === genre && <span className="text-xs">(kryesore)</span>}
                </label>
              );
            })}
          </div>
          {/* Sent in the order chosen: the first is the primary one. */}
          {categories.map((c) => (
            <input key={c} type="hidden" name="categories" value={c} />
          ))}
          <p id="details-categories-count" className={`mt-2 ${EDITOR_HINT_CLASSES}`}>
            {categories.length} nga {MAX_CATEGORIES} të zgjedhura
          </p>
        </fieldset>
        <FieldError id="details-categories-error" message={err("categories")} />
      </Section>

      <Section title="Fjalët kyçe" lead={`Fjalë që lexuesit mund të kërkojnë. Ndajini me presje, deri në ${MAX_KEYWORDS}.`}>
        <label className={EDITOR_FIELD_CLASSES}>
          <span className={EDITOR_LABEL_CLASSES}>
            Fjalët kyçe
            <Optional>opsionale</Optional>
          </span>
          <input
            name="keywords"
            data-field="keywords"
            type="text"
            value={keywords}
            disabled={pdFrozen}
            onChange={(e) => setKeywords(e.target.value)}
            aria-describedby={describe("keywords", "details-keywords-count")}
            className={editorControlClassesFor(!!err("keywords") || keywordCount > MAX_KEYWORDS)}
          />
          <span
            id="details-keywords-count"
            className={`text-[13px] ${keywordCount > MAX_KEYWORDS ? "font-medium text-red-800" : "text-muted"}`}
          >
            {keywordCount > MAX_KEYWORDS
              ? `${keywordCount} fjalë kyçe: hiqni ${keywordCount - MAX_KEYWORDS}.`
              : `${keywordCount} nga ${MAX_KEYWORDS}`}
          </span>
          <FieldError id="details-keywords-error" message={err("keywords")} />
          {pdFrozen && <input type="hidden" name="keywords" value={keywords} />}
        </label>
      </Section>

      {/* D1b (Renato 11-04): not pinned, like the other two tabs and the mockup. */}
      <div>
        {Object.keys(errors).length > 0 && (
          <p role="alert" className={`${fieldErrorClasses} mb-2`}>
            Disa fusha kanë nevojë për një ndryshim. Shikoni mesazhet më lart.
          </p>
        )}
        <EditorActionBar
          primaryLabel="Ruaj dhe vazhdo"
          primaryIntent="next"
          primaryNote="Hapi tjetër: Përmbajtja"
          saveLabel={live ? LIVE_SAVE_BUTTON : undefined}
        />
      </div>
    </form>
  );
}
