-- BD16 P1: exactly what 095_bd16_preorders.rollback.sql leaves behind
-- on purpose (see its header). Applied to the BASE schema by
-- 095_bd16_preorders_catalog_equivalence.sh, the result must equal a
-- rolled-back database in every catalog section.
-- LOCAL/DISPOSABLE DATABASE ONLY.

alter table public.books
  -- The day (Tirana) the book comes out. On a draft it is the date the
  -- author asks for; on a pre-order the current release day.
  add column release_date date,
  add column preorder_listed_at timestamptz,
  add column preorder_slip_used boolean not null default false,
  add column preorder_count smallint not null default 0
    constraint books_preorder_count_check
    check (preorder_count between 0 and 2),
  add column preorder_cancelled_at timestamptz;

alter table public.books
  add constraint books_preorder_check
    check (status <> 'preorder'
           or (release_date is not null
               and preorder_listed_at is not null
               and preorder_count >= 1
               and pd_work_id is null));

alter table public.book_reviews
  add column release_date date,
  -- A listing sent without a manuscript is approved with no "file opens".
  drop constraint book_reviews_checklist_check,
  add constraint book_reviews_checklist_check
    check (checklist = '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb
           or (file_path is null
               and checklist = '{"cover_is_fine": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb));

alter table public.account_suspensions
  add column preorder_book_ids uuid[] not null default '{}';

create table public.preorder_notify_requests (
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Set by the job (P5) just before it sends this reader's one email.
  notified_at timestamptz,
  -- Set when the pre-order ended; the email is then the "cancelled" one.
  book_cancelled_at timestamptz,
  primary key (book_id, user_id)
);

create index preorder_notify_requests_user_id_idx
  on public.preorder_notify_requests (user_id);

alter table public.preorder_notify_requests enable row level security;

-- A reader reads their own rows ("Njoftimet e mia"); the author never
-- sees who asked. The job (service role) marks and clears rows.
revoke all on public.preorder_notify_requests from public, anon, authenticated, service_role;
grant select on public.preorder_notify_requests to authenticated;
grant select, update, delete on public.preorder_notify_requests to service_role;

create policy "Readers see their own pre-order notices"
  on public.preorder_notify_requests
  for select
  to authenticated
  using (auth.uid() = user_id);

create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at,
         -- BD15 P7: null on a public-domain edition without an editor
         -- mention, for every reader (its author too).
         b.public_pen_name_id as pen_name_id,
         b.original_author,
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit,
         -- BD16 P1 residue: a view column is not dropped (see the header).
         b.release_date
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);
