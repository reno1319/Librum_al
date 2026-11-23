-- ROLLBACK for migration 20261123160000_publishing_house_pages.sql.
-- LOCAL/DISPOSABLE DATABASE TEST, or a deliberate rollback only.
-- Revert the app first. Lossy: every staff author link is dropped (the
-- audit log keeps the record). Puts public_pen_names back to its
-- 20261118170000 shape: the view is dropped and recreated (a view
-- can't lose columns in place), with its grants restated.

begin;

drop function if exists public.staff_link_house_author(uuid, text);
drop function if exists public.staff_unlink_house_author(uuid);

drop view if exists public.public_pen_names;

create view public.public_pen_names
  with (security_barrier)
as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links
  from public.pen_names pn
  where (
    -- A series or bundle holds books of its own pen name only (LB451
    -- triggers), so the book carries the rule for them too.
       exists (select 1 from public.books b
                where b.pen_name_id = pn.id
                  and public.book_makes_pen_name_public(b))
    -- Q1a: the author, and a reader who owns one of its books.
    or pn.author_id = auth.uid()
    or (auth.uid() is not null
        and exists (select 1 from public.books b
                     where b.pen_name_id = pn.id
                       and (b.pd_work_id is null or b.pd_editor_credit)
                       and public.user_owns_book(b.id)))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    )
    and not exists (
      select 1 from public.account_deletion_requests del
       where del.user_id = pn.author_id
    );

revoke all on table public.public_pen_names from public, anon, authenticated, service_role;
grant select on table public.public_pen_names to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger on table public.public_pen_names to service_role;

drop trigger if exists pen_names_linked_name_lock on public.pen_names;
drop function if exists public.pen_names_linked_name_lock();

drop index if exists public.pen_names_linked_pen_name_id_idx;
alter table public.pen_names
  drop constraint if exists pen_names_linked_not_self,
  drop column if exists linked_pen_name_id;

commit;
