import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "@/lib/blog-slug";

// K6 free Albanian classics (Renato 2026-11-16; migration
// 20261116180000_classic_authors.sql). A classic author is a dead
// author of public-domain works with their own page at
// /klasiket/<slug> (Q1 b). Readers see them only through the
// public_classic_authors view, which lists an author only while one of
// their works has a live edition (Q3 a), with pd_work_ids = those works.
// Staff add and edit them on /admin/books/public-domain/authors.

export type PublicClassicAuthor = {
  id: string;
  slug: string;
  name: string;
  birth_year: number;
  death_year: number;
  birth_place: string | null;
  death_place: string | null;
  bio: string;
  pd_work_ids: string[];
};

export const PUBLIC_CLASSIC_AUTHOR_COLUMNS =
  "id, slug, name, birth_year, death_year, birth_place, death_place, bio, pd_work_ids";

export function classicAuthorPath(slug: string): string {
  return `/klasiket/${encodeURIComponent(slug)}`;
}

// "1846–1900", with word joiners around the dash so a narrow card never
// breaks the years over two lines.
export function formatClassicYears(author: Pick<PublicClassicAuthor, "birth_year" | "death_year">): string {
  return `${author.birth_year}⁠–⁠${author.death_year}`;
}

// "Lindi në Frashër, 1846 · Vdiq në Stamboll, 1900" (a missing place:
// "Lindi më 1846").
export function formatClassicLifeLine(
  author: Pick<PublicClassicAuthor, "birth_year" | "death_year" | "birth_place" | "death_place">,
): string {
  const born = author.birth_place ? `Lindi në ${author.birth_place}, ${author.birth_year}` : `Lindi më ${author.birth_year}`;
  const died = author.death_place ? `Vdiq në ${author.death_place}, ${author.death_year}` : `Vdiq më ${author.death_year}`;
  return `${born} · ${died}`;
}

// Each work id -> its classic author, for the live authors that own any
// of these works. Fail-soft: an error gives an empty map (the byline
// then links to the Libraria search, as before K6).
export async function loadClassicAuthorsByWork(
  supabase: SupabaseClient,
  workIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, PublicClassicAuthor>> {
  const ids = [...new Set(workIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const byWork = new Map<string, PublicClassicAuthor>();
  if (ids.length === 0) return byWork;
  const { data, error } = await supabase
    .from("public_classic_authors")
    .select(PUBLIC_CLASSIC_AUTHOR_COLUMNS)
    .overlaps("pd_work_ids", ids)
    .returns<PublicClassicAuthor[]>();
  if (error) {
    console.error("Classic authors: read failed:", error);
    return byWork;
  }
  for (const author of data ?? []) {
    for (const workId of author.pd_work_ids ?? []) byWork.set(workId, author);
  }
  return byWork;
}

// ------------------------------------------------------------
// The staff form (admin, English).
// ------------------------------------------------------------
// The limits match the table's checks; the messages below spell them out
// (page-messages.ts lists every message word for word).
export const CLASSIC_NAME_MAX = 200;
export const CLASSIC_PLACE_MAX = 120;
export const CLASSIC_BIO_MAX = 3000;
export const CLASSIC_SLUG_MAX = 80;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ClassicAuthorInput = {
  id: string | null;
  slug: string;
  name: string;
  birthYear: number;
  deathYear: number;
  birthPlace: string | null;
  deathPlace: string | null;
  bio: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

// One line: any whitespace run becomes one space, control and invisible
// characters go, then trimmed.
function oneLine(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁯﻿]/g, "")
    .trim();
}

// The bio keeps its paragraphs: CRLF becomes LF, other control and
// invisible characters go, each line is trimmed, 3+ line breaks become
// one blank line.
export function normalizeClassicBio(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁯﻿]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function year(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{3,4}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1000 && n <= 2100 ? n : null;
}

export type ClassicAuthorValidation = { ok: true; value: ClassicAuthorInput } | { ok: false; error: string };

export function validateClassicAuthorForm(formData: FormData, nowYear: number): ClassicAuthorValidation {
  const rawId = text(formData, "id").trim();
  if (rawId && !UUID_PATTERN.test(rawId)) return { ok: false, error: "This author or work no longer exists." };
  const name = oneLine(text(formData, "name"));
  if (!name || name.length > CLASSIC_NAME_MAX) return { ok: false, error: "Enter a name (at most 200 characters)." };
  const slug = text(formData, "slug").trim() || slugify(name);
  if (!SLUG_PATTERN.test(slug) || slug.length > CLASSIC_SLUG_MAX) {
    return { ok: false, error: "The web address may use only a-z, 0-9 and single hyphens." };
  }
  const birthYear = year(text(formData, "birthYear"));
  const deathYear = year(text(formData, "deathYear"));
  if (birthYear === null || deathYear === null) return { ok: false, error: "Enter the birth and death year (four digits)." };
  if (deathYear < birthYear) return { ok: false, error: "The death year can't be before the birth year." };
  if (deathYear > nowYear - 71) {
    return { ok: false, error: "Only authors who died more than 70 years ago can be added." };
  }
  const birthPlace = oneLine(text(formData, "birthPlace")) || null;
  const deathPlace = oneLine(text(formData, "deathPlace")) || null;
  if ((birthPlace?.length ?? 0) > CLASSIC_PLACE_MAX || (deathPlace?.length ?? 0) > CLASSIC_PLACE_MAX) {
    return { ok: false, error: "A place may have at most 120 characters." };
  }
  const bio = normalizeClassicBio(text(formData, "bio"));
  if (!bio || bio.length > CLASSIC_BIO_MAX) return { ok: false, error: "Write a bio (at most 3000 characters)." };
  return { ok: true, value: { id: rawId || null, slug, name, birthYear, deathYear, birthPlace, deathPlace, bio } };
}

export function mapClassicAuthorRpcError(error: { code?: string | null }): string {
  switch (error.code) {
    case "23505":
      return "Another classic author already uses this web address.";
    case "LB515":
      return "Some fields are not valid. Check them and save again.";
    case "LB516":
      return "Only authors who died more than 70 years ago can be added.";
    case "LB517":
      return "This author or work no longer exists.";
    default:
      return "Couldn't save. Please try again.";
  }
}
