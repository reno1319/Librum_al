import { saveClassicAuthorAsStaff } from "../actions";
import { CLASSIC_BIO_MAX, CLASSIC_NAME_MAX, CLASSIC_PLACE_MAX, CLASSIC_SLUG_MAX } from "@/lib/classic-authors";

// K6 (Q1 a): the add/edit form for one classic author. The bio is shown
// to readers as written, so Renato writes or approves every bio before
// the author's first work goes live (capsule gate).

export type ClassicAuthorRow = {
  id: string;
  slug: string;
  name: string;
  birth_year: number;
  death_year: number;
  birth_place: string | null;
  death_place: string | null;
  bio: string;
};

const INPUT_CLASSES =
  "focus-ring min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-[0.9375rem] text-foreground";
const LABEL_CLASSES = "flex flex-col gap-1 text-sm font-semibold";
const HINT_CLASSES = "text-xs font-normal text-muted";

export function ClassicAuthorForm({ author }: { author: ClassicAuthorRow | null }) {
  return (
    <form action={saveClassicAuthorAsStaff} className="flex flex-col gap-4">
      {author && <input type="hidden" name="id" value={author.id} />}
      <label className={LABEL_CLASSES}>
        Name
        <input name="name" required maxLength={CLASSIC_NAME_MAX} defaultValue={author?.name ?? ""} className={INPUT_CLASSES} />
        <span className={HINT_CLASSES}>
          Write it exactly as on the books (the &ldquo;original author&rdquo;), e.g. Naim Frashëri.
        </span>
      </label>
      <label className={LABEL_CLASSES}>
        Web address
        <input
          name="slug"
          maxLength={CLASSIC_SLUG_MAX}
          defaultValue={author?.slug ?? ""}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          className={INPUT_CLASSES}
        />
        <span className={HINT_CLASSES}>
          The page is /klasiket/&lt;this&gt;. Leave empty to make it from the name (naim-frasheri).
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL_CLASSES}>
          Birth year
          <input
            name="birthYear"
            required
            inputMode="numeric"
            pattern="[0-9]{4}"
            defaultValue={author?.birth_year ?? ""}
            className={INPUT_CLASSES}
          />
        </label>
        <label className={LABEL_CLASSES}>
          Death year
          <input
            name="deathYear"
            required
            inputMode="numeric"
            pattern="[0-9]{4}"
            defaultValue={author?.death_year ?? ""}
            className={INPUT_CLASSES}
          />
          <span className={HINT_CLASSES}>More than 70 years ago, so the works are public domain.</span>
        </label>
        <label className={LABEL_CLASSES}>
          Birth place (optional)
          <input
            name="birthPlace"
            maxLength={CLASSIC_PLACE_MAX}
            defaultValue={author?.birth_place ?? ""}
            className={INPUT_CLASSES}
          />
        </label>
        <label className={LABEL_CLASSES}>
          Death place (optional)
          <input
            name="deathPlace"
            maxLength={CLASSIC_PLACE_MAX}
            defaultValue={author?.death_place ?? ""}
            className={INPUT_CLASSES}
          />
        </label>
      </div>
      <label className={LABEL_CLASSES}>
        Bio (Albanian, shown to readers)
        <textarea
          name="bio"
          required
          rows={6}
          maxLength={CLASSIC_BIO_MAX}
          defaultValue={author?.bio ?? ""}
          className={`${INPUT_CLASSES} min-h-36`}
        />
        <span className={HINT_CLASSES}>Renato writes or approves every bio before the author&rsquo;s first book goes live.</span>
      </label>
      <button
        type="submit"
        className="focus-ring inline-flex min-h-11 items-center justify-center self-start rounded-full bg-primary px-[1.125rem] text-[0.9375rem] font-semibold text-primary-foreground hover:opacity-90"
      >
        {author ? "Save changes" : "Add classic author"}
      </button>
    </form>
  );
}
