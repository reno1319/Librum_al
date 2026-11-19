import {
  CATEGORY_DESCRIPTION_MAX,
  CATEGORY_LABEL_MAX,
  CATEGORY_SHORT_LABEL_MAX,
  CATEGORY_URL_SLUG_MAX,
  CATEGORY_URL_SLUG_PATTERN,
} from "@/lib/blog-categories";
import { BLOG_CATEGORY_PICKABLE_COLOURS, type BlogCategoryColour } from "@/lib/blog-category-colours";

// Form checks for the category pages. A UX nicety only: the RPCs in
// migration 20261119180000 re-check every rule.
export type CategoryFields = {
  label: string;
  shortLabel: string;
  description: string;
  urlSlug: string;
  colour: BlogCategoryColour;
  cta: "publish" | "browse";
};

export function readCategoryFields(
  formData: FormData,
  mode: "new" | "edit" | "editorial",
): { ok: true; value: CategoryFields } | { ok: false; error: string } {
  const text = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const label = text("label");
  const shortLabel = text("shortLabel");
  const description = text("description");
  const urlSlug = text("urlSlug");
  const colour = text("colour");
  const cta = text("cta");

  if (!label || label.length > CATEGORY_LABEL_MAX) {
    return { ok: false, error: `Name must be 1 to ${CATEGORY_LABEL_MAX} characters.` };
  }
  if (!shortLabel || shortLabel.length > CATEGORY_SHORT_LABEL_MAX) {
    return { ok: false, error: `Short name must be 1 to ${CATEGORY_SHORT_LABEL_MAX} characters.` };
  }
  if (!description || description.length > CATEGORY_DESCRIPTION_MAX) {
    return { ok: false, error: `Description must be 1 to ${CATEGORY_DESCRIPTION_MAX} characters.` };
  }
  if (mode === "editorial") {
    return { ok: true, value: { label, shortLabel, description, urlSlug: "", colour: "gold", cta: "browse" } };
  }
  if (mode === "new" && (urlSlug.length > CATEGORY_URL_SLUG_MAX || !CATEGORY_URL_SLUG_PATTERN.test(urlSlug))) {
    return { ok: false, error: "Address: use only a-z, 0-9 and single dashes (for example perkthime-letrare)." };
  }
  if (!(BLOG_CATEGORY_PICKABLE_COLOURS as readonly string[]).includes(colour)) {
    return { ok: false, error: "Pick one of the 8 colours." };
  }
  if (cta !== "publish" && cta !== "browse") {
    return { ok: false, error: "Pick the button at the bottom of the page." };
  }
  return { ok: true, value: { label, shortLabel, description, urlSlug, colour: colour as BlogCategoryColour, cta } };
}

export function mapCategoryRpcError(error: { message?: string; code?: string } | null | undefined): string {
  const KNOWN: Record<string, string> = {
    "not authorized": "You don't have permission to do that.",
    "no such category": "That category could not be found. It may have just been deleted.",
    "category address already used": "That address is already used by another category. Pick another.",
    "invalid category address": "Address: use only a-z, 0-9 and single dashes.",
    "too many categories": "There are already 50 categories. Delete one before adding another.",
    "invalid colour": "Pick one of the 8 colours.",
    "invalid bottom button": "Pick the button at the bottom of the page.",
    "editorial cannot be deleted": "Editorial can't be deleted.",
    "editorial always comes first": "Editorial always comes first.",
    "choose where its articles move": "Choose another category for its articles.",
    "category name must be between 1 and 60 characters": "Name must be 1 to 60 characters.",
    "short name must be between 1 and 24 characters": "Short name must be 1 to 24 characters.",
    "description must be between 1 and 200 characters": "Description must be 1 to 200 characters.",
  };
  if (error?.code === "23505") return "That address is already used by another category. Pick another.";
  return KNOWN[error?.message ?? ""] ?? "Something went wrong. Please try again.";
}
