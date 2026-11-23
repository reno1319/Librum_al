-- BUILD 2b (publishing houses, Renato 11-23): the public house page,
-- "Botuar nga" and the staff author link.
--
-- 1. pen_names.linked_pen_name_id: staff link one of a house's authors
--    (a non-default pen name of a publishing-house account) to the SAME
--    name on the writer's own author account (b4 c: the names must
--    match, so a pen name never points at a different name). Written
--    only by staff_link_house_author() / staff_unlink_house_author()
--    below; `authenticated` keeps UPDATE on (name, bio, links) only.
--    Money is unchanged: books keep their own author_id.
-- 2. While linked, the house's author can't be renamed (b7 a): a
--    trigger refuses a name change unless the same update unlinks it.
--    The house can't change its bio or links either (g1 a: the
--    writer's own show); staff tools (e.g. removing links) still can.
-- 3. public_pen_names gets two columns, appended:
--      house_id            the house's default pen name, on every pen
--                          name of a publishing-house account (null for
--                          a person's pen names: their pseudonyms stay
--                          unconnected, as before);
--      linked_pen_name_id  on a house author that staff linked, only
--                          while the two names still match (b4 c: a
--                          writer who renames their name ends the
--                          public link; renaming back restores it).
--    and two more ways to be public: a house's default pen name (its
--    house page) once any of the house's books is public, and a writer's
--    linked name once a linked house book is public.
-- 4. The two staff functions, audit-logged like other staff actions.

-- ------------------------------------------------------------
-- 1. The link column
-- ------------------------------------------------------------
alter table public.pen_names
  add column linked_pen_name_id uuid
    references public.pen_names (id) on delete set null,
  add constraint pen_names_linked_not_self
    check (linked_pen_name_id is null or linked_pen_name_id <> id);

create index pen_names_linked_pen_name_id_idx
  on public.pen_names (linked_pen_name_id)
  where linked_pen_name_id is not null;

-- ------------------------------------------------------------
-- 2. A linked house author keeps its name (b7 a), bio and links (g1 a)
-- ------------------------------------------------------------
create function public.pen_names_linked_name_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.linked_pen_name_id is not null
     and new.linked_pen_name_id is not null
     and (new.name is distinct from old.name
          -- A direct write by a signed-in user (the house: only the
          -- owner can update the row) only. Staff tools such as
          -- removing links run as their definer and still work.
          or ((new.bio is distinct from old.bio or new.links is distinct from old.links)
              and current_user = 'authenticated')) then
    raise exception 'pen name is linked' using errcode = 'LB530';
  end if;
  return new;
end;
$$;

revoke all on function public.pen_names_linked_name_lock() from public, anon, authenticated;

create trigger pen_names_linked_name_lock
  before update of name, bio, links on public.pen_names
  for each row execute function public.pen_names_linked_name_lock();

-- ------------------------------------------------------------
-- 3. public_pen_names: two columns appended, two more public cases
-- ------------------------------------------------------------
create or replace view public.public_pen_names
  with (security_barrier)
as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links,
         -- BUILD 2b: appended last. Scalar subqueries, no join, so the
         -- view keeps its one FROM item (an UPDATE against it is still
         -- refused by privileges, as before).
         case when exists (select 1 from public.profiles p
                            where p.id = pn.author_id and p.account_kind = 'publishing_house')
              then (select d.id from public.pen_names d
                     where d.author_id = pn.author_id and d.is_default)
         end as house_id,
         -- b4 c: only while the writer's name still matches.
         case when not pn.is_default
               and exists (select 1 from public.profiles p
                            where p.id = pn.author_id and p.account_kind = 'publishing_house')
               and exists (select 1 from public.pen_names t
                            where t.id = pn.linked_pen_name_id
                              and lower(t.name) = lower(pn.name))
              then pn.linked_pen_name_id
         end as linked_pen_name_id
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
    -- BUILD 2b: a house's own page, once any of its books is public.
    or (pn.is_default
        and exists (select 1 from public.profiles p
                     where p.id = pn.author_id and p.account_kind = 'publishing_house')
        and exists (select 1 from public.books b
                     where b.author_id = pn.author_id
                       and public.book_makes_pen_name_public(b)))
    -- BUILD 2b: a writer's name that a house author is linked to, once
    -- a public book of that house author is not hidden.
    or exists (select 1
                 from public.pen_names h
                 join public.profiles hp
                   on hp.id = h.author_id and hp.account_kind = 'publishing_house'
                 join public.books b on b.pen_name_id = h.id
                where h.linked_pen_name_id = pn.id
                  and not h.is_default
                  -- b4 c: only while the two names still match.
                  and lower(h.name) = lower(pn.name)
                  and public.book_makes_pen_name_public(b)
                  and not exists (
                    select 1 from public.account_suspensions sus
                     where sus.user_id = h.author_id and sus.lifted_at is null)
                  and not exists (
                    select 1 from public.account_deletion_requests del
                     where del.user_id = h.author_id))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    )
    and not exists (
      select 1 from public.account_deletion_requests del
       where del.user_id = pn.author_id
    );

-- ------------------------------------------------------------
-- 4. The staff link and unlink
-- ------------------------------------------------------------
-- Returns: 'linked', 'not_found' (no such pen name), 'not_house_author'
-- (not a non-default pen name of a house), 'already_linked',
-- 'no_account' (no account with that email), 'same_account',
-- 'not_author' (the account is not a person's author account),
-- 'no_match' (none of its names equals the house author's name).
create function public.staff_link_house_author(
  p_pen_name_id uuid,
  p_email text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_pen public.pen_names%rowtype;
  v_kind text;
  v_target_user uuid;
  v_target_role text;
  v_target_kind text;
  v_target_pen uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('people.manage') then
    raise exception 'not authorized';
  end if;

  select * into v_pen from public.pen_names where id = p_pen_name_id for update;
  if not found then
    return 'not_found';
  end if;
  select account_kind into v_kind from public.profiles where id = v_pen.author_id;
  if v_kind is distinct from 'publishing_house' or v_pen.is_default then
    return 'not_house_author';
  end if;
  if v_pen.linked_pen_name_id is not null then
    return 'already_linked';
  end if;

  if v_email = '' then
    return 'no_account';
  end if;
  select u.id into v_target_user from auth.users u where pg_catalog.lower(u.email) = v_email limit 1;
  if v_target_user is null then
    return 'no_account';
  end if;
  if v_target_user = v_pen.author_id then
    return 'same_account';
  end if;
  select role, account_kind into v_target_role, v_target_kind
    from public.profiles where id = v_target_user;
  if v_target_role is distinct from 'author' or v_target_kind is distinct from 'person' then
    return 'not_author';
  end if;

  -- b4 c: the same name (the per-account unique key is lower(name)).
  select t.id into v_target_pen
    from public.pen_names t
   where t.author_id = v_target_user
     and pg_catalog.lower(t.name) = pg_catalog.lower(v_pen.name);
  if v_target_pen is null then
    return 'no_match';
  end if;

  update public.pen_names set linked_pen_name_id = v_target_pen where id = v_pen.id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'house_author.linked', 'pen_names', v_pen.id,
          pg_catalog.jsonb_build_object('linked_pen_name_id', v_target_pen,
                                        'linked_user_id', v_target_user));
  return 'linked';
end;
$$;

-- Returns 'unlinked', 'not_found' or 'not_linked'.
create function public.staff_unlink_house_author(p_pen_name_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_old uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('people.manage') then
    raise exception 'not authorized';
  end if;

  select linked_pen_name_id into v_old from public.pen_names where id = p_pen_name_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_old is null then
    return 'not_linked';
  end if;

  update public.pen_names set linked_pen_name_id = null where id = p_pen_name_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'house_author.unlinked', 'pen_names', p_pen_name_id,
          pg_catalog.jsonb_build_object('linked_pen_name_id', v_old));
  return 'unlinked';
end;
$$;

revoke all on function public.staff_link_house_author(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.staff_unlink_house_author(uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_link_house_author(uuid, text) to authenticated;
grant execute on function public.staff_unlink_house_author(uuid) to authenticated;
