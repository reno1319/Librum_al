-- LOCAL/DISPOSABLE DATABASE TEST ONLY until a reviewed plan says
-- otherwise. Rollback for BD14 (migration 20261103160000): puts
-- public_pen_names and public_series back exactly as the base had them
-- (PEOPLE-1, migration 20261023090000: any book, series or bundle row
-- lists a pen name, every series is listed, no security_barrier) and
-- drops book_makes_pen_name_public(). Views only; no data is touched.
-- Running it twice changes nothing more.
--
-- CREATE OR REPLACE VIEW without a WITH clause replaces the view's
-- options with none, so security_barrier goes too; the grants stay.

begin;

-- A second run would print a NOTICE for the already-dropped function.
set local client_min_messages = warning;

create or replace view public.public_pen_names as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links
  from public.pen_names pn
  where (
       exists (select 1 from public.books b where b.pen_name_id = pn.id)
    or exists (select 1 from public.series s where s.pen_name_id = pn.id)
    or exists (select 1 from public.bundles bu where bu.pen_name_id = pn.id)
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    );

create or replace view public.public_series as
  select s.id, s.title, s.pen_name_id, s.created_at
  from public.series s
  where not exists (
    select 1 from public.account_suspensions sus
     where sus.user_id = s.author_id and sus.lifted_at is null
  );

drop function if exists public.book_makes_pen_name_public(public.books);

commit;
