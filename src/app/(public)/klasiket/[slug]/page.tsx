import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import { getAuthorInitials } from "@/lib/author-initials";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { canonicalMetadata } from "@/lib/seo";
import {
  classicAuthorPath,
  formatClassicLifeLine,
  formatClassicYears,
  PUBLIC_CLASSIC_AUTHOR_COLUMNS,
  type PublicClassicAuthor,
} from "@/lib/classic-authors";
import type { PublicBook } from "@/lib/types";

// K6 free Albanian classics (Renato 2026-11-16, Q1 b; approved pictures
// v4): a classic author's own page. Name and years, the birth and death
// line, the staff-written bio and "Veprat në Librum". LR1 (lr1-8 a):
// the box back to all the classics and its "Klasikët shqiptarë" step in
// the path are gone with the Libraria list they opened. No Follow button (Q1 b), no label (Q5 b), no "why
// free" line (Q3 a). Only while one of their works has a live edition
// (Q3 a): public_classic_authors lists nobody else, so the page and its
// metadata both 404 otherwise.

// Reads the maintenance env var on every request, like every page that
// renders books.price_all through BookCard.
export const dynamic = "force-dynamic";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type ClassicPageData = { author: PublicClassicAuthor; books: PublicBook[] };

const getClassicPageData = cache(async (slug: string): Promise<ClassicPageData | null> => {
  if (!SLUG_PATTERN.test(slug) || slug.length > 80) return null;
  const supabase = await createClient();
  const { data: author } = await supabase
    .from("public_classic_authors")
    .select(PUBLIC_CLASSIC_AUTHOR_COLUMNS)
    .eq("slug", slug)
    .maybeSingle<PublicClassicAuthor>();
  if (!author || !author.pd_work_ids?.length) return null;

  const { data: books } = await supabase
    .from("public_books")
    .select("*")
    .in("pd_work_id", author.pd_work_ids)
    .eq("status", "published")
    .not("price_all", "is", null)
    .order("title", { ascending: true })
    .returns<PublicBook[]>();
  if (!books || books.length === 0) return null;

  return { author, books };
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) return {};
  const { slug } = await params;
  const data = await getClassicPageData(slug);
  if (!data) return {};
  const { author } = data;
  return {
    title: `${author.name} (${author.birth_year}–${author.death_year})`,
    description: `${author.name}: veprat në Librum, falas.`,
    ...canonicalMetadata(classicAuthorPath(author.slug)),
  };
}

export default async function ClassicAuthorPage({ params }: { params: Promise<{ slug: string }> }) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { slug } = await params;
  const data = await getClassicPageData(slug);
  if (!data) notFound();

  const { author, books } = data;
  // Local URL construction only (no network call).
  const supabase = await createClient();

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <nav aria-label="Rruga" className="mb-6 text-sm text-muted">
        <Link href="/librari" className="focus-ring rounded-sm underline underline-offset-2">
          Libraria
        </Link>
        {" › "}
        <span aria-current="page">{author.name}</span>
      </nav>

      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-6">
        <div
          aria-hidden="true"
          className="flex size-20 shrink-0 items-center justify-center rounded-full border border-[#e3d9c3] bg-[#f6f1e6] font-serif text-2xl text-[#5a4630] sm:size-28 sm:text-3xl"
        >
          {getAuthorInitials(author.name)}
        </div>
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-normal text-foreground sm:text-3xl">
            {author.name} <span className="text-muted">({formatClassicYears(author)})</span>
          </h1>
          <p className="mt-1 text-sm text-muted">{formatClassicLifeLine(author)}</p>
          <p className="mt-3 max-w-[42.5rem] whitespace-pre-line text-sm text-foreground/90 sm:text-base">
            {author.bio}
          </p>
        </div>
      </div>

      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-normal">Veprat në Librum</h2>
        <ul className="mt-6 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {books.map((book) => (
            <li key={book.id}>
              {/* No authorName: every book here is by this author, named above. */}
              <BookCard
                book={book}
                coverUrl={
                  book.cover_path ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl : null
                }
              />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
