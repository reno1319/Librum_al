-- BD15 P1: exactly what 090_bd15_upload_flow_foundation.rollback.sql
-- leaves behind on purpose (see its header). Applied to the BASE schema
-- by 090_bd15_upload_flow_foundation_catalog_equivalence.sh, the result
-- must equal a rolled-back database in every catalog section.
-- LOCAL/DISPOSABLE DATABASE ONLY.

create table public.pd_works (
  id uuid primary key default gen_random_uuid(),
  title text not null
    constraint pd_works_title_check
    check (char_length(title) between 1 and 300
           and title = btrim(title)
           and title !~ '[[:cntrl:]]'),
  original_author text not null
    constraint pd_works_original_author_check
    check (char_length(original_author) between 1 and 200
           and original_author = btrim(original_author)
           and original_author !~ '[[:cntrl:]]'),
  picked_book_id uuid
    constraint pd_works_picked_book_id_key unique,
  created_at timestamptz not null default now()
);

alter table public.pd_works enable row level security;

revoke all on public.pd_works from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.pd_works to service_role;

alter table public.books
  add column categories text[],
  add column is_adult boolean not null default false,
  add column reading_age_min smallint,
  add column edition_number integer,
  add column pd_work_id uuid
    constraint books_pd_work_id_fkey references public.pd_works(id),
  add column pd_editor_credit boolean not null default false;

create table public.book_ai_disclosures (
  book_id uuid primary key references public.books(id) on delete cascade,
  ai_used boolean not null,
  answered_at timestamptz not null default now()
);

alter table public.book_ai_disclosures enable row level security;

revoke all on public.book_ai_disclosures from public, anon, authenticated, service_role;
grant select, insert, update on public.book_ai_disclosures to service_role;

create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at, b.pen_name_id,
         b.original_author,
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit
  from public.books b
  where b.status = 'published'
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);
