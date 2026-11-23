-- BR1 (Renato 2026-11-23): reader reactions on blog articles.
--
--   br1 q1  three reactions: 'like' (Më pëlqen), 'helpful' (E
--           dobishme), 'inspired' (Më frymëzoi).
--   br1 q2  signed-in readers only.
--   br1 q3  a reader may pick several; each one turns on and off.
--   br1 q4  public totals (the app hides a zero).
--   br1 q6  staff see the totals in the admin Blog list, never who.
--
-- WHAT CHANGES (no existing row is touched):
--   1. blog_post_reactions: one row per (article, reader, reaction).
--      Both ids cascade: a deleted article or a deleted account (the
--      day-30 deleteUser) takes its reactions with it. RLS on; a reader
--      reads only their own rows; authenticated holds SELECT only, anon
--      and service_role nothing. Every write goes through (3).
--   2. blog_post_reaction_counts(uuid[]): totals per article and
--      reaction for live articles only (published, published_at
--      reached). Numbers only, no user id. anon + authenticated (the
--      signed-out article page shows totals). At most 500 ids a call.
--   3. toggle_blog_post_reaction(uuid, text): turns one reaction on or
--      off for the caller and returns true when it is now on. Refuses:
--      no sign-in, a suspended account or one waiting for deletion
--      (LB524), an unknown reaction (LB525), an article that is not
--      live (LB526). authenticated only.
--
-- SAFETY: one transaction; only new objects.
-- ROLLOUT ORDER: apply BEFORE the app in the same patch is deployed (the
-- new app calls both functions; on the old database the article page
-- would show no reactions and a tap would show the generic error).
-- ROLLBACK: supabase/tests/111_blog_post_reactions.rollback.sql (lossy:
-- every reaction is dropped with the table).

begin;

-- 1. The table.
create table public.blog_post_reactions (
  post_id uuid not null references public.blog_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null
    constraint blog_post_reactions_reaction_check check (reaction in ('like', 'helpful', 'inspired')),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (post_id, user_id, reaction)
);

create index blog_post_reactions_user_id_idx on public.blog_post_reactions (user_id);

alter table public.blog_post_reactions enable row level security;

create policy "Readers read their own blog reactions"
  on public.blog_post_reactions for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.blog_post_reactions from public, anon, authenticated, service_role;
grant select on public.blog_post_reactions to authenticated;

-- 2. The totals.
create function public.blog_post_reaction_counts(p_post_ids uuid[])
returns table (post_id uuid, reaction text, total integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_post_ids is null or pg_catalog.cardinality(p_post_ids) = 0 then
    return;
  end if;
  if pg_catalog.cardinality(p_post_ids) > 500 then
    raise exception 'blog_post_reaction_counts: too many articles' using errcode = '22023';
  end if;
  return query
    select r.post_id, r.reaction, pg_catalog.count(*)::integer
      from public.blog_post_reactions r
      join public.blog_posts p on p.id = r.post_id
     where r.post_id = any (p_post_ids)
       and p.status = 'published'
       and p.published_at is not null
       and p.published_at <= pg_catalog.now()
     group by r.post_id, r.reaction;
end;
$$;

revoke all on function public.blog_post_reaction_counts(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.blog_post_reaction_counts(uuid[]) to anon, authenticated;

-- 3. Turning one reaction on or off.
create function public.toggle_blog_post_reaction(p_post_id uuid, p_reaction text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if exists (
    select 1 from public.account_suspensions s
     where s.user_id = v_uid and s.lifted_at is null
  ) or exists (
    select 1 from public.account_deletion_requests d
     where d.user_id = v_uid
  ) then
    raise exception 'toggle_blog_post_reaction: account not active' using errcode = 'LB524';
  end if;
  if p_reaction is null or p_reaction not in ('like', 'helpful', 'inspired') then
    raise exception 'toggle_blog_post_reaction: invalid reaction' using errcode = 'LB525';
  end if;
  if not exists (
    select 1 from public.blog_posts p
     where p.id = p_post_id
       and p.status = 'published'
       and p.published_at is not null
       and p.published_at <= pg_catalog.now()
  ) then
    raise exception 'toggle_blog_post_reaction: article not live' using errcode = 'LB526';
  end if;

  delete from public.blog_post_reactions r
   where r.post_id = p_post_id and r.user_id = v_uid and r.reaction = p_reaction;
  if found then
    return false;
  end if;

  -- Two quick taps at once: the second insert finds the first one's row
  -- and leaves it on, never an error.
  insert into public.blog_post_reactions (post_id, user_id, reaction)
  values (p_post_id, v_uid, p_reaction)
  on conflict (post_id, user_id, reaction) do nothing;
  return true;
end;
$$;

revoke all on function public.toggle_blog_post_reaction(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.toggle_blog_post_reaction(uuid, text) to authenticated;

commit;
