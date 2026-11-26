-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for LR1 patch 4
-- (supabase/migrations/20261126090000_libraria_reading_picks.sql).
-- Drops the two staff functions, the public view and the picks table
-- (Libraria then shows no "Çfarë po lexojmë" box and the "Më shumë"
-- page is empty), and puts staff_has_permission() back as migration
-- 20261119180000_blog_categories_manage left it (an admin loses
-- catalog.feature in the database again). The audit rows stay.

begin;

drop function public.staff_delete_libraria_reading_pick(uuid);
drop function public.staff_save_libraria_reading_pick(uuid, uuid, text, text, text, text);
drop view public.public_libraria_reading_picks;
drop table public.libraria_reading_picks;

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view',
            'finance.view', 'finance.payout_export', 'finance.payout_operate',
            'blog.view', 'blog.manage', 'blog.categories', 'books.review',
            'people.view', 'people.manage'
          )
        )
        or (
          sm.role = 'editor'
          and p_permission in ('admin.access', 'blog.view', 'blog.manage')
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;

commit;
