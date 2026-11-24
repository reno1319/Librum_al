-- G1 security pass (Renato 11-24, "gr a"): three Payment & tax
-- leftovers from the build-3 audit (F4, F5, F6), on top of migration
-- 20261123200000_author_tax_details.sql. No table changes, no data
-- changes.
--
-- 1. set_author_tax_details() and set_author_payout_destination():
--    authors only (profiles.role = 'author'). Before this, any
--    signed-in account could save them (F5). Rows a reader may already
--    have saved are left alone: they are the reader's own data, and
--    nothing reads them unless the account becomes an author.
-- 2. iban_country_length(): the exact IBAN length per country (SWIFT
--    IBAN registry, 97 codes). set_author_payout_destination() now
--    refuses a lek-account IBAN whose length is wrong for its country,
--    or whose country has no IBANs (F6). The MOD-97 checksum was
--    already checked (055) and still is.
-- 3. request_book_review(): a PAID draft needs the author's Payment &
--    tax details before review (LB527), the database's own copy of the
--    app's rule (F4). Otherwise the body is the BD16 one
--    (20261106120000), unchanged.
--
-- Every function keeps SECURITY DEFINER and an empty search_path; the
-- grants are restated so this file says the whole truth on its own.

-- ------------------------------------------------------------
-- 1. Tax details: authors only
-- ------------------------------------------------------------
create or replace function public.set_author_tax_details(
  p_country_code text,
  p_legal_name text,
  p_tax_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_country text;
  v_name text;
  v_tax_id text;
begin
  if v_uid is null then
    raise exception 'set_author_tax_details: not authenticated';
  end if;

  -- G1: authors only (a reader's account has no books to sell).
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'author') then
    raise exception 'set_author_tax_details: only authors can save tax details';
  end if;

  v_country := upper(btrim(coalesce(p_country_code, '')));
  v_name := btrim(regexp_replace(coalesce(p_legal_name, ''), '\s+', ' ', 'g'));
  -- Spaces, dashes, dots and slashes are typing help only.
  v_tax_id := upper(regexp_replace(coalesce(p_tax_id, ''), '[\s./-]+', '', 'g'));

  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'set_author_tax_details: country is required';
  end if;
  if v_name = '' or char_length(v_name) > 200 then
    raise exception 'set_author_tax_details: legal name is required';
  end if;
  if v_country = 'AL' and v_tax_id !~ '^[A-Z][0-9]{8}[A-Z]$' then
    raise exception 'set_author_tax_details: nid format is not valid';
  end if;
  if v_country <> 'AL' and v_tax_id !~ '^[A-Z0-9]{4,30}$' then
    raise exception 'set_author_tax_details: tax number format is not valid';
  end if;

  insert into public.author_tax_details (author_id, country_code, legal_name, tax_id, updated_at)
  values (v_uid, v_country, v_name, v_tax_id, now())
  on conflict on constraint author_tax_details_pkey do update
    set country_code = excluded.country_code,
        legal_name = excluded.legal_name,
        tax_id = excluded.tax_id,
        updated_at = now();
end;
$$;

revoke all on function public.set_author_tax_details(text, text, text) from public, anon, authenticated;
grant execute on function public.set_author_tax_details(text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. IBAN length per country
-- ------------------------------------------------------------
create or replace function public.iban_country_length(p_country text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select v.len
  from (values
    ('AD',24), ('AE',23), ('AL',28), ('AT',20), ('AX',18), ('AZ',28),
    ('BA',20), ('BE',16), ('BG',22), ('BH',22), ('BR',29), ('BY',28),
    ('CH',21), ('CR',22), ('CY',28), ('CZ',24), ('DE',22), ('DK',18),
    ('DO',28), ('EE',20), ('EG',29), ('ES',24), ('FI',18), ('FO',18),
    ('FR',27), ('GB',22), ('GE',22), ('GF',27), ('GI',23), ('GL',18),
    ('GP',27), ('GR',27), ('GT',28), ('HR',21), ('HU',28), ('IE',22),
    ('IL',23), ('IQ',23), ('IS',26), ('IT',27), ('JO',30), ('KW',30),
    ('KZ',20), ('LB',28), ('LC',32), ('LI',21), ('LT',20), ('LU',20),
    ('LV',21), ('LY',25), ('MC',27), ('MD',24), ('ME',22), ('MF',27),
    ('MK',19), ('MN',20), ('MQ',27), ('MR',27), ('MT',31), ('MU',30),
    ('NC',27), ('NI',28), ('NL',18), ('NO',15), ('OM',23), ('PF',27),
    ('PK',24), ('PL',28), ('PM',27), ('PS',29), ('PT',25), ('QA',29),
    ('RE',27), ('RO',24), ('RS',22), ('RU',33), ('SA',24), ('SC',31),
    ('SD',18), ('SE',24), ('SI',19), ('SK',24), ('SM',27), ('SO',23),
    ('ST',25), ('SV',28), ('TF',27), ('TL',23), ('TN',24), ('TR',26),
    ('UA',29), ('VA',22), ('VG',24), ('WF',27), ('XK',20), ('YE',30),
    ('YT',27)
  ) as v(code, len)
  where v.code = p_country;
$$;

revoke all on function public.iban_country_length(text) from public, anon, authenticated, service_role;
grant execute on function public.iban_country_length(text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Bank account: authors only, exact IBAN length
-- ------------------------------------------------------------
create or replace function public.set_author_payout_destination(
  p_currency text,
  p_beneficiary_name text,
  p_iban text
)
returns table (
  currency text,
  beneficiary_name text,
  iban text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_beneficiary_name text;
  v_iban text;
begin
  -- G1: authors only, like the tax details (the two halves of Payment &
  -- tax). A signed-out caller has no profile, so it is refused here too.
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'author') then
    raise exception 'set_author_payout_destination: only authors can save a bank account';
  end if;

  v_currency := upper(btrim(coalesce(p_currency, '')));
  v_beneficiary_name := btrim(coalesce(p_beneficiary_name, ''));
  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'set_author_payout_destination: currency must be a 3-letter ISO code';
  end if;

  if v_beneficiary_name = '' then
    raise exception 'set_author_payout_destination: beneficiary_name is required and must not be blank';
  end if;

  if v_iban = '' then
    raise exception 'set_author_payout_destination: iban is required and must not be blank';
  end if;

  -- BUILD 3 (t3 a): any country's IBAN shape (15-34 characters); an
  -- Albanian one must still be exactly AL + 26.
  if v_currency = 'ALL' and v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then
    raise exception 'set_author_payout_destination: iban does not match the expected IBAN format';
  end if;

  if v_currency = 'ALL' and v_iban like 'AL%' and v_iban !~ '^AL[0-9]{2}[A-Z0-9]{24}$' then
    raise exception 'set_author_payout_destination: iban does not match the expected Albanian IBAN format (AL + 26 digits/letters)';
  end if;

  -- G1 (g1q1): the exact length for the IBAN's country (SWIFT IBAN
  -- registry). A country without IBANs, or a wrong length, is refused
  -- with the same message as a bad shape. Albania stays AL + 26 = 28.
  if v_currency = 'ALL'
     and public.iban_country_length(substr(v_iban, 1, 2)) is distinct from char_length(v_iban)
  then
    raise exception 'set_author_payout_destination: iban does not match the expected IBAN format';
  end if;

  if not public.iban_mod97_valid(v_iban) then
    raise exception 'set_author_payout_destination: iban fails checksum validation -- this only confirms the format is well-formed, never that the account exists or belongs to you';
  end if;

  -- ON CONFLICT ON CONSTRAINT: see migration 055 (the OUT parameter
  -- "currency" makes a bare column list ambiguous).
  insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban, updated_at)
  values (auth.uid(), v_currency, v_beneficiary_name, v_iban, now())
  on conflict on constraint author_payout_destinations_pkey do update
    set beneficiary_name = excluded.beneficiary_name,
        iban = excluded.iban,
        updated_at = now();

  currency := v_currency;
  beneficiary_name := v_beneficiary_name;
  iban := v_iban;
  select apd.updated_at into updated_at
  from public.author_payout_destinations apd
  where apd.author_id = auth.uid() and apd.currency = v_currency;
  return next;
end;
$$;

revoke all on function public.set_author_payout_destination(text, text, text) from public, anon;
grant execute on function public.set_author_payout_destination(text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Send for review: a paid draft needs Payment & tax
-- ------------------------------------------------------------
create or replace function public.request_book_review(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book record;
  v_change record;
  v_pending record;
  v_review_id uuid;
  v_file_path text;
  v_cover_path text;
  v_original_author text;
  v_description text;
  v_is_adult boolean;
  v_release_date date;
  v_today date;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  select bo.id, bo.title, bo.author_id, bo.status, bo.file_path, bo.cover_path, bo.original_author,
         bo.description, bo.is_adult, bo.categories, bo.release_date, bo.preorder_count, bo.pd_work_id, bo.price_all
    into v_book
    from public.books bo
   where bo.id = p_book_id
     for update;

  if not found or v_book.author_id is distinct from v_actor_id then
    raise exception 'no book found for this id';
  end if;

  if v_book.status not in ('draft', 'published', 'preorder') then
    raise exception 'this book is already published';
  end if;

  if exists (
    select 1 from public.book_takedowns t
     where t.book_id = p_book_id and t.lifted_at is null
  ) then
    raise exception 'Librum took this book down. It can''t be published again until Librum allows it.'
      using errcode = 'LB460';
  end if;

  v_release_date := null;
  if v_book.status in ('published', 'preorder') then
    -- BD15 P5b-1: a live book sends its pending changes; it stays live.
    -- BD16: so does a pre-order (its final file comes this way).
    select c.file_path, c.cover_path, c.original_author, c.description, c.is_adult
      into v_change
      from public.book_pending_changes c
     where c.book_id = p_book_id;
    if not found
       or (v_change.file_path, v_change.cover_path, v_change.original_author, v_change.description, v_change.is_adult)
          is not distinct from
          (v_book.file_path, v_book.cover_path, v_book.original_author, v_book.description, v_book.is_adult)
    then
      raise exception 'this live book has no changes to send'
        using errcode = 'LB494';
    end if;
    v_file_path := v_change.file_path;
    v_cover_path := v_change.cover_path;
    v_original_author := v_change.original_author;
    v_description := v_change.description;
    v_is_adult := v_change.is_adult;
    if v_is_adult and v_book.categories && array['Për fëmijë', 'Për të rinj']::text[] then
      raise exception 'An 18+ book can''t be in the children''s or teen categories.'
        using errcode = 'LB493';
    end if;
  else
    v_file_path := v_book.file_path;
    v_cover_path := v_book.cover_path;
    v_original_author := v_book.original_author;
    v_description := v_book.description;
    v_is_adult := v_book.is_adult;
    if v_book.release_date is not null then
      -- BD16: a draft with a release date asks for a pre-order listing.
      if v_book.preorder_count >= 2 then
        raise exception 'This book has had its 2 pre-orders. It can still be published normally.'
          using errcode = 'LB501';
      end if;
      if v_book.pd_work_id is not null
         or (select d.basis
               from public.book_rights_declarations d
              where d.book_id = p_book_id
              order by d.declared_at desc, d.id desc
              limit 1) = 'public_domain'
      then
        raise exception 'A public-domain book can''t be a pre-order.'
          using errcode = 'LB502';
      end if;
      v_today := public.tirana_today();
      if v_book.release_date < v_today + 14
         or v_book.release_date > (v_today + interval '6 months')::date
      then
        raise exception 'A pre-order''s release date is 14 days to 6 months from today.'
          using errcode = 'LB500';
      end if;
      v_release_date := v_book.release_date;
    elsif public.book_review_approval_valid(p_book_id, v_file_path, v_cover_path, v_original_author,
                                            v_description, v_is_adult) then
      raise exception 'this book is already approved';
    end if;
  end if;

  -- BD15 P5a: the Content tab's three answers (manuscript, cover, "AI
  -- used") are required before Librum is asked to look at the book. An
  -- already approved draft is answered above (it needs no new review).
  -- BD16 (D5): a pre-order's manuscript may come later.
  if (v_file_path is null and v_release_date is null and v_book.status <> 'preorder')
     or v_cover_path is null
     or not exists (select 1 from public.book_ai_disclosures d where d.book_id = p_book_id)
  then
    raise exception 'this book needs a manuscript, a cover and the AI answer before review'
      using errcode = 'LB489';
  end if;

  -- G1 (Renato 11-24, "gr a"): a PAID draft also needs the author's
  -- Payment & tax details (tax details + lek bank account) before
  -- Librum is asked to look at it -- the database's own copy of the
  -- app's checkPublishGate rule (BUILD 3, sg1 a). A free book never
  -- asks. Live books and pre-orders sending changes are not re-gated,
  -- the same as the app. Yes/no only: no value is read or echoed.
  if v_book.status = 'draft'
     and coalesce(v_book.price_all, 0) > 0
     and not public.author_payment_details_ready_for(v_actor_id)
  then
    raise exception 'a paid book needs the Payment & tax details before review'
      using errcode = 'LB527';
  end if;

  select r.id, r.file_path, r.cover_path, r.original_author, r.description, r.is_adult, r.release_date
    into v_pending
    from public.book_reviews r
   where r.book_id = p_book_id
     and r.status = 'pending'
     for update;

  if found then
    if (v_pending.file_path, v_pending.cover_path, v_pending.original_author, v_pending.description,
        v_pending.is_adult, v_pending.release_date)
       is not distinct from
       (v_file_path, v_cover_path, v_original_author, v_description, v_is_adult, v_release_date) then
      raise exception 'this book is already waiting for review';
    end if;
    update public.book_reviews
       set status = 'cancelled',
           decided_at = pg_catalog.now()
     where id = v_pending.id;
  end if;

  insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author,
                                   description, is_adult, release_date, status)
  values (p_book_id, v_book.title, v_book.author_id, v_file_path, v_cover_path, v_original_author,
          v_description, v_is_adult, v_release_date, 'pending')
  returning id into v_review_id;

  return v_review_id;
end;
$$;

revoke all on function public.request_book_review(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_book_review(uuid) to authenticated;
