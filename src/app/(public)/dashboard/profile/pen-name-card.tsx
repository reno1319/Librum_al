import Link from "next/link";
import { updatePenName, deletePenName } from "../pen-names/actions";
import { buttonClasses } from "@/components/ui/button";
import { AvatarField } from "@/components/avatar-field";
import { formControlClasses } from "@/lib/form-styles";
import {
  PEN_NAME_BIO_MAX_LENGTH,
  PEN_NAME_LINK_MAX_LENGTH,
  PEN_NAME_MAX_LENGTH,
  PEN_NAME_MAX_LINKS,
  authorPagePath,
  readPenNameLinks,
  type OwnPenName,
} from "@/lib/pen-names";

export const MAIN_CARD_FORM_ID = "main-author-card";

// The four ways a pen name card is shown:
//   "main"        an author's main author name (build 1);
//   "pseudonym"   an author's other pen name (build 1);
//   "house"       a publishing house's own card on Profili (BUILD 2a-2,
//                 approved picture 6): its main pen name is the house;
//   "houseAuthor" one of a house's authors on Autorët (picture 7).
export type PenNameCardKind = "main" | "pseudonym" | "house" | "houseAuthor";

// BUILD 2a-2: the house's Autorët forms tell the pen name actions to come
// back to Autorët with author wording (see pen-names/actions.ts).
export const FROM_AUTHORS_FIELD = "from";
export const FROM_AUTHORS_VALUE = "authors";

const WORDING: Record<
  PenNameCardKind,
  {
    nameLabel: string;
    bioLabel: string;
    bioPlaceholder: string;
    photoLabel?: string;
    removePhotoLabel: string;
    deleteLabel: string | null;
  }
> = {
  main: {
    nameLabel: "Emri juaj i autorit",
    bioLabel: "Biografia (opsionale)",
    bioPlaceholder: "Disa fjali për ju, që lexuesit i shohin në faqen tuaj të autorit.",
    removePhotoLabel: "Hiqeni foton",
    deleteLabel: null,
  },
  pseudonym: {
    nameLabel: "Emri",
    bioLabel: "Biografia (opsionale)",
    bioPlaceholder: "Disa fjali që lexuesit i shohin në faqen e autorit të këtij pseudonimi.",
    removePhotoLabel: "Hiqeni foton",
    deleteLabel: "Fshini pseudonimin",
  },
  house: {
    nameLabel: "Emri i shtëpisë botuese",
    bioLabel: "Rreth shtëpisë botuese (opsionale)",
    bioPlaceholder: "Disa fjali për shtëpinë tuaj botuese, që lexuesit i shohin në faqen e saj.",
    photoLabel: "Logoja (JPEG ose PNG, deri në 5 MB)",
    removePhotoLabel: "Hiqeni logon",
    deleteLabel: null,
  },
  houseAuthor: {
    nameLabel: "Emri",
    bioLabel: "Biografia (opsionale)",
    bioPlaceholder: "Disa fjali që lexuesit i shohin në faqen e këtij autori.",
    removePhotoLabel: "Hiqeni foton",
    deleteLabel: "Hiqni autorin",
  },
};

// One pen name: photo (or logo), name, bio (or about), links and Ruani;
// "Fshini pseudonimin" / "Hiqni autorin" only for a non-default pen name
// that no book, series or bundle uses (the action checks again).
export function PenNameCard({
  kind,
  penName,
  userId,
  photoUrl,
  bookCount,
  used,
}: {
  kind: PenNameCardKind;
  penName: OwnPenName;
  userId: string;
  photoUrl: string | null;
  bookCount: number;
  used: boolean;
}) {
  const wording = WORDING[kind];
  const isMain = kind === "main" || kind === "house";
  const links = readPenNameLinks(penName.links);
  const Heading = isMain ? "h2" : "h3";
  const fromAuthors =
    kind === "houseAuthor" ? <input type="hidden" name={FROM_AUTHORS_FIELD} value={FROM_AUTHORS_VALUE} /> : null;

  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading className="min-w-0 break-words font-serif text-xl font-normal text-primary">{penName.name}</Heading>
        <p className="text-xs text-muted">
          {bookCount} {bookCount === 1 ? "libër" : "libra"}
        </p>
      </div>
      {kind === "main" && <p className="mt-1 text-sm text-muted">Ky emër shfaqet te librat tuaj dhe te faqja juaj e autorit.</p>}
      {/* A house's own page comes with build 2b (k1); until then no link. */}
      {used && kind !== "house" && (
        <Link
          href={authorPagePath(penName.id)}
          className="focus-ring mt-1 inline-block rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
        >
          Shikoni faqen e autorit &rarr;
        </Link>
      )}

      <form
        id={kind === "main" ? MAIN_CARD_FORM_ID : undefined}
        action={updatePenName.bind(null, penName.id)}
        className="mt-4 flex flex-col gap-4"
      >
        {fromAuthors}
        <AvatarField userId={userId} existingAvatarUrl={photoUrl} label={wording.photoLabel} />
        {photoUrl && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="removePhoto" className="focus-ring size-4" />
            {wording.removePhotoLabel}
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm">
          {wording.nameLabel}
          <input
            name="name"
            type="text"
            required
            maxLength={PEN_NAME_MAX_LENGTH}
            defaultValue={penName.name}
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {wording.bioLabel}
          <textarea
            name="bio"
            rows={4}
            maxLength={PEN_NAME_BIO_MAX_LENGTH}
            defaultValue={penName.bio ?? ""}
            placeholder={wording.bioPlaceholder}
            className={formControlClasses}
          />
        </label>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Lidhjet (opsionale, deri në {PEN_NAME_MAX_LINKS})</legend>
          {Array.from({ length: PEN_NAME_MAX_LINKS }, (_, i) => (
            <input
              key={i}
              name="links"
              type="url"
              inputMode="url"
              maxLength={PEN_NAME_LINK_MAX_LENGTH}
              pattern="https://.*"
              placeholder="https://"
              aria-label={`Lidhja ${i + 1}`}
              defaultValue={links[i] ?? ""}
              className={formControlClasses}
            />
          ))}
          <span className="text-muted">Adresa të plota interneti që fillojnë me https://.</span>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonClasses("primary", "md")}>
            Ruani
          </button>
        </div>
      </form>

      {wording.deleteLabel && !isMain && !used && (
        <form action={deletePenName.bind(null, penName.id)} className="mt-3">
          {fromAuthors}
          <button
            type="submit"
            className="focus-ring rounded-full border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            {wording.deleteLabel}
          </button>
        </form>
      )}
    </div>
  );
}
