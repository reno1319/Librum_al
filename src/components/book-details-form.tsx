"use client";

import { useRef, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
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
import { PEN_NAME_LOCKED_NOTE, TITLE_LOCKED_NOTE, TITLE_WILL_LOCK_NOTE } from "@/lib/book-editor-copy";
import { fieldErrorClasses, formControlClassesFor } from "@/lib/form-styles";
import { buttonClasses } from "@/components/ui/button";
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

const SECTION_CLASSES = "grid gap-4 border-t border-border pt-6 sm:grid-cols-[14rem_1fr]";
const SECTION_TITLE_CLASSES = "font-serif text-xl text-foreground";
const TEXT_LINK_CLASSES =
  "focus-ring w-fit rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span id={id} className={fieldErrorClasses}>
      {message}
    </span>
  );
}

function Section({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section className={SECTION_CLASSES}>
      <div>
        <h2 className={SECTION_TITLE_CLASSES}>{title}</h2>
        {lead && <p className="mt-1 text-sm text-muted">{lead}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

function SaveButtons() {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-col items-end gap-2">
      {pending && (
        <p role="status" className="text-sm text-muted">
          Po ruhet…
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending}
          className={buttonClasses("outline", "md", "min-h-11 rounded-full disabled:cursor-not-allowed disabled:opacity-60")}
        >
          Ruaj draftin
        </button>
        <button
          type="submit"
          name="intent"
          value="next"
          disabled={pending}
          className={buttonClasses("primary", "md", "min-h-11 rounded-full disabled:cursor-not-allowed disabled:opacity-60")}
        >
          Ruaj dhe vazhdo →
        </button>
      </div>
    </div>
  );
}

export function BookDetailsForm({
  action,
  initial,
  locked,
  lockedPenName,
  penNames,
  series: initialSeries,
}: {
  action: (formData: FormData) => void | Promise<void>;
  initial: DetailsFormValues;
  // The book has been published once: title and pen name are fixed.
  locked: boolean;
  lockedPenName: string | null;
  penNames: EditorPenName[];
  series: EditorSeries[];
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
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-8">
      <Section title="Gjuha" lead="Gjuha në të cilën është shkruar libri.">
        <label className="flex max-w-xs flex-col gap-1 text-sm">
          Gjuha
          <select
            name="language"
            data-field="language"
            defaultValue={initial.language || "sq"}
            aria-describedby={describe("language")}
            className={formControlClassesFor(!!err("language"))}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <FieldError id="details-language-error" message={err("language")} />
        </label>
      </Section>

      <Section title="Titulli" lead="Shkruajeni saktësisht si në kopertinë.">
        {locked ? (
          <div className="flex flex-col gap-1 text-sm">
            <span>Titulli i librit</span>
            <p className="rounded-control border border-border bg-background px-3 py-2 text-base">{initial.title}</p>
            <span className="text-sm text-muted">{TITLE_LOCKED_NOTE}</span>
            <input type="hidden" name="title" value={initial.title} />
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Titulli i librit
            <input
              name="title"
              data-field="title"
              type="text"
              required
              maxLength={TITLE_MAX_LENGTH}
              defaultValue={initial.title}
              aria-invalid={err("title") ? true : undefined}
              aria-describedby={describe("title", "details-title-hint")}
              className={formControlClassesFor(!!err("title"))}
            />
            <span id="details-title-hint" className="text-sm text-muted">
              {TITLE_WILL_LOCK_NOTE}
            </span>
            <FieldError id="details-title-error" message={err("title")} />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Nëntitulli (opsional)
          <input
            name="subtitle"
            data-field="subtitle"
            type="text"
            maxLength={SUBTITLE_MAX_LENGTH}
            defaultValue={initial.subtitle}
            aria-describedby={describe("subtitle")}
            className={formControlClassesFor(!!err("subtitle"))}
          />
          <FieldError id="details-subtitle-error" message={err("subtitle")} />
        </label>
      </Section>

      <Section title="Autori" lead="Emri që shohin lexuesit vjen nga profili juaj.">
        {locked ? (
          <div className="flex flex-col gap-1 text-sm">
            <span>Emri i autorit</span>
            <p className="rounded-control border border-border bg-background px-3 py-2 text-base">{lockedPenName}</p>
            <span className="text-sm text-muted">{PEN_NAME_LOCKED_NOTE}</span>
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Emri i autorit
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
              className={formControlClassesFor(!!err("penNameId"))}
            >
              {penNames.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-sm text-muted">
              Shtoni ose ndryshoni emra te{" "}
              <Link href="/dashboard/pen-names" className={TEXT_LINK_CLASSES}>
                Profili → Emrat e autorit
              </Link>
              .
            </span>
          </label>
        )}

        <fieldset className="flex flex-col gap-3" data-field="contributors" tabIndex={-1} aria-describedby={describe("contributors")}>
          <legend className="text-sm">Kontribues të tjerë (deri në {MAX_CONTRIBUTORS})</legend>
          {contributors.map((c, i) => (
            <div key={c.id || `new-${i}`} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="contributorId" value={c.id} />
              <label className="flex flex-col gap-1 text-sm">
                Roli
                <select
                  name="contributorRole"
                  value={c.role}
                  onChange={(e) =>
                    setContributors((list) => list.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))
                  }
                  className={formControlClassesFor(false)}
                >
                  {CONTRIBUTOR_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {contributorRoleLabel(role)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
                Emri
                <input
                  name="contributorName"
                  type="text"
                  maxLength={CONTRIBUTOR_NAME_MAX_LENGTH}
                  value={c.name}
                  onChange={(e) =>
                    setContributors((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                  className={formControlClassesFor(false)}
                />
              </label>
              <button
                type="button"
                onClick={() => setContributors((list) => list.filter((_, j) => j !== i))}
                className={buttonClasses("ghost", "sm", "min-h-10")}
              >
                Hiq
              </button>
            </div>
          ))}
          {contributors.length < MAX_CONTRIBUTORS ? (
            <button
              type="button"
              onClick={() => setContributors((list) => [...list, { id: "", name: "", role: "Co-Author" }])}
              className={buttonClasses("outline", "sm", "w-fit rounded-full")}
            >
              + Shto kontribues
            </button>
          ) : (
            <p className="text-sm text-muted">Keni arritur kufirin prej {MAX_CONTRIBUTORS} kontribuesish.</p>
          )}
          <FieldError id="details-contributors-error" message={err("contributors")} />
        </fieldset>
      </Section>

      <Section
        title="Seria"
        lead="Nëse libri është pjesë e një serie, lidheni këtu. Të gjithë librat e një serie dalin me të njëjtin emër autori."
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
            Seria
            <select
              name="seriesId"
              value={seriesId}
              onChange={(e) => setSeriesId(e.target.value)}
              className={formControlClassesFor(false)}
            >
              <option value="">Nuk është pjesë e një serie</option>
              {seriesForPenName.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-32 flex-col gap-1 text-sm">
            Numri në seri
            <input
              name="seriesPosition"
              data-field="seriesPosition"
              type="text"
              inputMode="numeric"
              disabled={!seriesId}
              defaultValue={initial.seriesPosition}
              aria-describedby={describe("seriesPosition")}
              className={formControlClassesFor(!!err("seriesPosition"))}
            />
          </label>
        </div>
        <FieldError id="details-seriesPosition-error" message={err("seriesPosition")} />
        {!locked || penNameId ? (
          newSeriesOpen ? (
            <div className="flex flex-col gap-2 rounded-control border border-border p-3">
              <label className="flex flex-col gap-1 text-sm">
                Emri i serisë së re
                <input
                  type="text"
                  maxLength={300}
                  value={newSeriesTitle}
                  onChange={(e) => setNewSeriesTitle(e.target.value)}
                  className={formControlClassesFor(!!newSeriesMessage)}
                />
              </label>
              <p className="text-sm text-muted">
                Të gjithë librat e serisë dalin me emrin{" "}
                {penNames.find((p) => p.id === penNameId)?.name ?? lockedPenName ?? ""}.
              </p>
              {newSeriesMessage && <p className={fieldErrorClasses}>{newSeriesMessage}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={newSeriesBusy}
                  onClick={createSeries}
                  className={buttonClasses("primary", "sm", "rounded-full")}
                >
                  Krijo serinë
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewSeriesOpen(false);
                    setNewSeriesMessage("");
                  }}
                  className={buttonClasses("ghost", "sm")}
                >
                  Anulo
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNewSeriesOpen(true)}
              className={buttonClasses("outline", "sm", "w-fit rounded-full")}
            >
              + Krijo seri të re
            </button>
          )
        ) : null}
        <p className="text-sm text-muted">
          Draftet nuk shfaqen në faqen e serisë. Nëse një libër hiqet nga shitja, vendi i tij mbetet “Nuk është në
          dispozicion” dhe numrat nuk ndryshojnë.
        </p>
      </Section>

      <Section title="Botimi" lead="Opsional. Përdoreni kur del një botim i ri i të njëjtit libër.">
        <label className="flex w-40 flex-col gap-1 text-sm">
          Numri i botimit
          <input
            name="editionNumber"
            data-field="editionNumber"
            type="text"
            inputMode="numeric"
            maxLength={String(EDITION_NUMBER_MAX).length}
            defaultValue={initial.editionNumber}
            aria-describedby={describe("editionNumber")}
            className={formControlClassesFor(!!err("editionNumber"))}
          />
        </label>
        <FieldError id="details-editionNumber-error" message={err("editionNumber")} />
      </Section>

      <Section title="Përshkrimi" lead="Ky tekst del në faqen e librit. Shkruajeni për lexuesin.">
        <span id="details-description-label" className="text-sm">
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
      </Section>

      <Section title="Të drejtat" lead="Kush i ka të drejtat e këtij teksti?">
        <fieldset className="flex flex-col gap-2" data-field="rightsBasis" tabIndex={-1}>
          <legend className="sr-only">Të drejtat</legend>
          {RIGHTS_BASES.map((basis) => (
            <label key={basis} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="rightsBasis"
                value={basis}
                checked={rightsBasis === basis}
                onChange={() => setRightsBasis(basis)}
                className="mt-1"
              />
              <span>{RIGHTS_STATEMENTS[basis].text}</span>
            </label>
          ))}
          <FieldError id="details-rightsBasis-error" message={err("rightsBasis")} />
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          Autori origjinal{rightsBasis === "public_domain" || rightsBasis === "public_domain_original" ? "" : " (opsional)"}
          <input
            name="originalAuthor"
            data-field="originalAuthor"
            type="text"
            maxLength={ORIGINAL_AUTHOR_MAX_LENGTH}
            defaultValue={initial.originalAuthor}
            aria-describedby={describe("originalAuthor", "details-originalAuthor-hint")}
            className={formControlClassesFor(!!err("originalAuthor"))}
          />
          <span id="details-originalAuthor-hint" className="text-sm text-muted">
            {ORIGINAL_AUTHOR_HINT}
          </span>
          <FieldError id="details-originalAuthor-error" message={err("originalAuthor")} />
        </label>
      </Section>

      <Section title="Lexuesit" lead="Ndihmon prindërit dhe lexuesit të gjejnë librin e duhur.">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm">A ka përmbajtje vetëm për të rritur (18+)?</legend>
          <div className="flex gap-4">
            {[
              { value: "no", label: "Jo" },
              { value: "yes", label: "Po" },
            ].map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="isAdult"
                  value={o.value}
                  checked={isAdult === (o.value === "yes")}
                  onChange={() => {
                    const adult = o.value === "yes";
                    setIsAdult(adult);
                    if (adult) setReadingAge("18");
                  }}
                />
                {o.label}
              </label>
            ))}
          </div>
          {isAdult && (
            <p className="text-sm text-muted">
              Libri shfaqet si zakonisht, me shënimin “18+” te të dhënat e librit. Nuk mund të jetë te “Për fëmijë” ose
              “Për të rinj”.
            </p>
          )}
        </fieldset>
        <label className="flex w-48 flex-col gap-1 text-sm">
          Mosha e leximit nga
          <select
            name="readingAge"
            data-field="readingAge"
            value={isAdult ? "18" : readingAge}
            disabled={isAdult}
            onChange={(e) => setReadingAge(e.target.value)}
            aria-describedby={describe("readingAge")}
            className={formControlClassesFor(!!err("readingAge"))}
          >
            <option value="">Pa caktuar</option>
            {READING_AGES.map((age) => (
              <option key={age} value={String(age)}>
                {age === 18 ? "18+" : `${age} vjeç`}
              </option>
            ))}
          </select>
          {isAdult && <input type="hidden" name="readingAge" value="18" />}
        </label>
        <FieldError id="details-readingAge-error" message={err("readingAge")} />
      </Section>

      <Section title="Kategoritë" lead={`Zgjidhni deri në ${MAX_CATEGORIES}. E para që zgjidhni është kategoria kryesore.`}>
        <fieldset data-field="categories" tabIndex={-1} aria-describedby={describe("categories", "details-categories-count")}>
          <legend className="sr-only">Kategoritë</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {GENRES.map((genre) => {
              const on = categories.includes(genre);
              const blockedByAdult = isAdult && CHILDREN_CATEGORIES.includes(genre);
              const full = !on && categories.length >= MAX_CATEGORIES;
              return (
                <label key={genre} className={`flex items-center gap-2 text-sm ${blockedByAdult || full ? "text-muted" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={(blockedByAdult && !on) || full}
                    onChange={(e) => toggleCategory(genre, e.target.checked)}
                  />
                  {genre}
                  {categories[0] === genre && <span className="text-xs text-muted">(kryesore)</span>}
                </label>
              );
            })}
          </div>
          {/* Sent in the order chosen: the first is the primary one. */}
          {categories.map((c) => (
            <input key={c} type="hidden" name="categories" value={c} />
          ))}
          <p id="details-categories-count" className="mt-2 text-sm text-muted">
            {categories.length} nga {MAX_CATEGORIES} të zgjedhura
          </p>
        </fieldset>
        <FieldError id="details-categories-error" message={err("categories")} />
      </Section>

      <Section title="Fjalët kyçe" lead={`Fjalë që lexuesit mund të kërkojnë. Ndajini me presje, deri në ${MAX_KEYWORDS}.`}>
        <label className="flex flex-col gap-1 text-sm">
          Fjalët kyçe
          <input
            name="keywords"
            data-field="keywords"
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            aria-describedby={describe("keywords", "details-keywords-count")}
            className={formControlClassesFor(!!err("keywords") || keywordCount > MAX_KEYWORDS)}
          />
          <span
            id="details-keywords-count"
            className={`text-sm ${keywordCount > MAX_KEYWORDS ? "font-medium text-red-800" : "text-muted"}`}
          >
            {keywordCount > MAX_KEYWORDS
              ? `${keywordCount} fjalë kyçe: hiqni ${keywordCount - MAX_KEYWORDS}.`
              : `${keywordCount} nga ${MAX_KEYWORDS}`}
          </span>
          <FieldError id="details-keywords-error" message={err("keywords")} />
        </label>
      </Section>

      <div className="sticky bottom-0 -mx-4 border-t border-border bg-background px-4 py-3 sm:mx-0 sm:px-0">
        {Object.keys(errors).length > 0 && (
          <p role="alert" className={`${fieldErrorClasses} mb-2`}>
            Disa fusha kanë nevojë për një ndryshim. Shikoni mesazhet më lart.
          </p>
        )}
        <SaveButtons />
      </div>
    </form>
  );
}
