-- LIBRUM 2.0 PUBLISHING-UX-1 PART B: adds optional bibliographic
-- metadata to `books` -- subtitle, language, publisher, edition,
-- original_publication_date -- plus published_at, a new system-
-- authoritative "first published on Librum" timestamp.
--
-- All six columns are additive and nullable. No backfill: an existing
-- book's language and true first-publish moment are both genuinely
-- unknown, so guessing (e.g. defaulting every existing row to
-- language='sq', or deriving published_at from created_at/updated_at)
-- would silently fabricate history rather than honestly represent its
-- absence -- see PUBLISHING-UX-1 Part A's own audit for the full
-- reasoning. No index (no query filters/sorts on any of these six
-- columns yet), no uniqueness constraint, no new RLS policy, no new
-- grant, no new SECURITY DEFINER function -- every one of these
-- columns lives entirely under `books`' own existing RLS policies
-- (migration 002), untouched by this migration.
--
-- language is deliberately NOT constrained by a DB CHECK. The launch
-- language set (sq/en/it -- see src/lib/languages.ts) is product
-- configuration, validated in TypeScript at every write path
-- (createBook()/updateBook() in src/app/(public)/dashboard/books/
-- actions.ts), not a permanent database invariant -- adding a fourth
-- supported language later should never require a migration.
--
-- published_at is system-authoritative: set exactly once, only by the
-- server's own publish path (performPublish(), same actions.ts file),
-- the first time a book genuinely transitions from draft to published.
-- Never accepted from author-submitted form data (createBook()/
-- updateBook() never read a "publishedAt"/"published_at" form field at
-- all), and never overwritten by a later unpublish/republish cycle or
-- by editing the book -- performPublish() only ever sets it when it is
-- currently null.
--
-- subtitle/publisher/edition each carry a conservative length CHECK
-- (300/200/100 chars respectively) since, unlike every other text
-- field on this table, these three are new public-facing bibliographic
-- fields with no existing length precedent to inherit -- mirrors the
-- same `text ... check (col is null or char_length(col) <= N)` shape
-- already used elsewhere in this schema (e.g. refund_requests.reason).

alter table public.books
  add column subtitle text check (subtitle is null or char_length(subtitle) <= 300),
  add column language text,
  add column publisher text check (publisher is null or char_length(publisher) <= 200),
  add column edition text check (edition is null or char_length(edition) <= 100),
  add column original_publication_date date,
  add column published_at timestamptz;
