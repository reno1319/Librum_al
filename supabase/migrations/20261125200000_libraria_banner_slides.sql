-- LR1 PATCH 3 (Renato 2026-11-25: lr1-2, lr1-2c a, lr3-1 a, lr3-2 b,
-- lr3-2b a, lr3-3 a, lr3-4 b, lr3-5 a, lr3-7 a, lr3-8 a, lr3-9 b): the
-- banner slides at the top of Libraria.
--
-- WHAT CHANGES:
--   1. public.libraria_banner_slides: one row per slide, in the order
--      staff gave them. A slide is a picture staff upload (image_path,
--      plus an optional taller phone picture, lr3-9 b), a book staff
--      pick (its title, cover and link come from the book, lr3-1 a,
--      lr1-2c a), a one-line description (at most 120 characters), an
--      optional tag staff type (at most 24 characters, lr3-2 b, lr3-2b
--      a) and an optional first and last day, Tirana time (lr3-4 b).
--      Staff with catalog.feature read every row; nobody writes it
--      directly.
--   2. public.public_libraria_banner_slides: what Libraria shows. Only
--      slides whose book Libraria lists now (published or pre-order,
--      priced, lr3-8 a; a book that stops being listed hides its slide,
--      which comes back with the book, lr3-5 a) and whose days include
--      today in Tirana, in order. Everyone may read it.
--   3. staff_save_libraria_banner_slide(), staff_delete_libraria_banner_slide()
--      and staff_move_libraria_banner_slide(): catalog.feature (owner
--      and admin), checked inside, each audited. Saving refuses a book
--      Libraria does not list (LB539) and any day on which more than 6
--      slides would show (LB538, lr3-7 a). Deleting closes up the order.
--   4. Storage bucket "libraria": public pictures, written only by the
--      app's service role after the staff check (no storage policies).
--
-- No existing row changes.

-- ------------------------------------------------------------
-- 1. The slides.
-- ------------------------------------------------------------
create table public.libraria_banner_slides (
  id uuid primary key default gen_random_uuid(),
  position smallint not null
    constraint libraria_banner_slides_position_check check (position >= 1),
  book_id uuid not null references public.books (id) on delete cascade,
  description text not null
    constraint libraria_banner_slides_description_check
    check (description = pg_catalog.btrim(description)
           and pg_catalog.char_length(description) between 1 and 120
           and description !~ '[\r\n]'),
  tag text
    constraint libraria_banner_slides_tag_check
    check (tag is null
           or (tag = pg_catalog.btrim(tag)
               and pg_catalog.char_length(tag) between 1 and 24
               and tag !~ '[\r\n]')),
  image_path text not null
    constraint libraria_banner_slides_image_path_check
    check (image_path ~ '^slides/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  phone_image_path text
    constraint libraria_banner_slides_phone_image_path_check
    check (phone_image_path is null
           or phone_image_path ~ '^slides/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  starts_on date,
  ends_on date,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint libraria_banner_slides_days_check
    check (starts_on is null or ends_on is null or ends_on >= starts_on),
  constraint libraria_banner_slides_position_key unique (position)
    deferrable initially immediate
);

create index libraria_banner_slides_book_id_idx on public.libraria_banner_slides (book_id);

alter table public.libraria_banner_slides enable row level security;

revoke all on public.libraria_banner_slides from public, anon, authenticated, service_role;
grant select on public.libraria_banner_slides to authenticated, service_role;

create policy libraria_banner_slides_staff_read
  on public.libraria_banner_slides
  for select
  to authenticated
  using (public.staff_has_permission('catalog.feature'));

create policy libraria_banner_slides_service_read
  on public.libraria_banner_slides
  for select
  to service_role
  using (true);

comment on table public.libraria_banner_slides is
  'LR1 patch 3: the Libraria banner slides, in order. Written only by the staff_*_libraria_banner_slide() functions.';

-- ------------------------------------------------------------
-- 2. What Libraria shows: listed book, today (Tirana) inside the days.
-- ------------------------------------------------------------
create view public.public_libraria_banner_slides
  with (security_barrier)
as
  select s.id, s.position, s.book_id, s.description, s.tag,
         s.image_path, s.phone_image_path
  from public.libraria_banner_slides s
  join public.books b on b.id = s.book_id
  where public.book_is_publicly_listed(b)
    and b.price_all is not null
    and (s.starts_on is null
         or s.starts_on <= (pg_catalog.now() at time zone 'Europe/Tirane')::date)
    and (s.ends_on is null
         or s.ends_on >= (pg_catalog.now() at time zone 'Europe/Tirane')::date);

revoke all on public.public_libraria_banner_slides from public, anon, authenticated, service_role;
grant select on public.public_libraria_banner_slides to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Staff functions.
-- ------------------------------------------------------------

-- The most slides that would show on any one day from today on, with
-- the given row's days in place of its stored ones (p_id null = a new
-- slide). Slides that already ended don't count. The busiest day is
-- always today or some slide's first day, so only those are checked.
create function public.libraria_banner_busiest_day_count(
  p_id uuid,
  p_starts_on date,
  p_ends_on date
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with today as (
    select (pg_catalog.now() at time zone 'Europe/Tirane')::date as d
  ),
  w as (
    select coalesce(s.starts_on, '-infinity'::date) as s,
           coalesce(s.ends_on, 'infinity'::date) as e
      from public.libraria_banner_slides s
     where p_id is null or s.id <> p_id
    union all
    select coalesce(p_starts_on, '-infinity'::date),
           coalesce(p_ends_on, 'infinity'::date)
  ),
  live as (
    select w.s, w.e from w, today where w.e >= today.d
  ),
  points as (
    select greatest(live.s, today.d) as p from live, today
  )
  select coalesce(max((select count(*) from live where live.s <= points.p and live.e >= points.p)), 0)::integer
    from points
$$;

revoke all on function public.libraria_banner_busiest_day_count(uuid, date, date) from public, anon, authenticated, service_role;

create function public.staff_save_libraria_banner_slide(
  p_id uuid,
  p_book_id uuid,
  p_description text,
  p_tag text,
  p_image_path text,
  p_phone_image_path text,
  p_starts_on date,
  p_ends_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_id uuid;
  v_tag text := nullif(pg_catalog.btrim(coalesce(p_tag, '')), '');
  v_description text := pg_catalog.btrim(coalesce(p_description, ''));
  v_before jsonb;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('catalog.feature') then
    raise exception 'not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.libraria_banner_slides'));

  if not exists (
    select 1 from public.books b
     where b.id = p_book_id
       and public.book_is_publicly_listed(b)
       and b.price_all is not null
  ) then
    raise exception 'That book is not on Libraria now.'
      using errcode = 'LB539';
  end if;

  if p_id is not null then
    select pg_catalog.to_jsonb(s.*) into v_before
      from public.libraria_banner_slides s
     where s.id = p_id
       for update;
    if v_before is null then
      return null;
    end if;
  end if;

  if public.libraria_banner_busiest_day_count(p_id, p_starts_on, p_ends_on) > 6 then
    raise exception 'At most 6 slides can show on the same day.'
      using errcode = 'LB538';
  end if;

  if p_id is null then
    insert into public.libraria_banner_slides
      (position, book_id, description, tag, image_path, phone_image_path, starts_on, ends_on)
    values (
      (select coalesce(max(s.position), 0) + 1 from public.libraria_banner_slides s),
      p_book_id, v_description, v_tag, p_image_path, p_phone_image_path, p_starts_on, p_ends_on
    )
    returning id into v_id;
  else
    update public.libraria_banner_slides
       set book_id = p_book_id,
           description = v_description,
           tag = v_tag,
           image_path = p_image_path,
           phone_image_path = p_phone_image_path,
           starts_on = p_starts_on,
           ends_on = p_ends_on,
           updated_at = pg_catalog.now()
     where id = p_id
    returning id into v_id;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'libraria.banner_slide_saved', 'libraria_banner_slides', v_id,
          pg_catalog.jsonb_build_object(
            'before', v_before,
            'after', (select pg_catalog.to_jsonb(s.*) from public.libraria_banner_slides s where s.id = v_id)));
  return v_id;
end;
$$;

revoke all on function public.staff_save_libraria_banner_slide(uuid, uuid, text, text, text, text, date, date) from public, anon, authenticated, service_role;
grant execute on function public.staff_save_libraria_banner_slide(uuid, uuid, text, text, text, text, date, date) to authenticated;

create function public.staff_delete_libraria_banner_slide(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_before jsonb;
  v_position smallint;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('catalog.feature') then
    raise exception 'not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.libraria_banner_slides'));

  delete from public.libraria_banner_slides s
   where s.id = p_id
  returning pg_catalog.to_jsonb(s.*), s.position into v_before, v_position;

  if v_before is null then
    return false;
  end if;

  -- Close up the order (one row at a time, lowest first, so the unique
  -- position never clashes).
  update public.libraria_banner_slides s
     set position = s.position - 1
   where s.position > v_position;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'libraria.banner_slide_deleted', 'libraria_banner_slides', p_id,
          pg_catalog.jsonb_build_object('before', v_before));
  return true;
end;
$$;

revoke all on function public.staff_delete_libraria_banner_slide(uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_delete_libraria_banner_slide(uuid) to authenticated;

create function public.staff_move_libraria_banner_slide(p_id uuid, p_up boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_position smallint;
  v_other_id uuid;
  v_other_position smallint;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('catalog.feature') then
    raise exception 'not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.libraria_banner_slides'));

  select s.position into v_position from public.libraria_banner_slides s where s.id = p_id;
  if v_position is null then
    return false;
  end if;

  if coalesce(p_up, true) then
    select s.id, s.position into v_other_id, v_other_position
      from public.libraria_banner_slides s
     where s.position < v_position
     order by s.position desc
     limit 1;
  else
    select s.id, s.position into v_other_id, v_other_position
      from public.libraria_banner_slides s
     where s.position > v_position
     order by s.position asc
     limit 1;
  end if;

  if v_other_id is null then
    return false;
  end if;

  set constraints public.libraria_banner_slides_position_key deferred;
  update public.libraria_banner_slides set position = v_other_position where id = p_id;
  update public.libraria_banner_slides set position = v_position where id = v_other_id;
  set constraints public.libraria_banner_slides_position_key immediate;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'libraria.banner_slide_moved', 'libraria_banner_slides', p_id,
          pg_catalog.jsonb_build_object('from', v_position, 'to', v_other_position));
  return true;
end;
$$;

revoke all on function public.staff_move_libraria_banner_slide(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.staff_move_libraria_banner_slide(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 4. The pictures: a public bucket, written only by the service role.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('libraria', 'libraria', true, 5242880, array['image/jpeg'])
on conflict (id) do nothing;
