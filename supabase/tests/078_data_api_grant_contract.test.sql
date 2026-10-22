-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for Supabase's 2026-10-30 Data API
-- change: new tables and views in public no longer get SELECT, INSERT,
-- UPDATE or DELETE for anon, authenticated and service_role by default
-- (00_stub_supabase_platform.sql models the new default; schema.sql's
-- last section grants explicitly what the old default used to give).
--
-- * Snapshot: every table/view/sequence privilege and every column
--   privilege that anon, authenticated and service_role hold in public
--   (MAINTAIN excluded) must equal the 213 rows below EXACTLY, both ways.
--   The rows are staging's real grants, read on 2026-10-22, which equal
--   the old-default rebuild of schema.sql. A relation with no privilege
--   for a role is a row with '-'.
-- * Guard: anon holds no privilege at all (MAINTAIN included), checked
--   as its effective privilege (PUBLIC and role membership count), on
--   pen_names, books, profiles, purchases or payments.
-- * No table, view or column in public is granted to PUBLIC.
--
-- A new table or view needs explicit revoke + grant lines in its
-- migration and in schema.sql (revoke all on <rel> from public, anon,
-- authenticated, service_role; then the grants it needs). Update this
-- snapshot only on purpose, in the same change.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/078_data_api_grant_contract.test.sql
--
-- Against the schema.sql without its 2026-10-30 grant section it fails
-- (service_role and others lose their grants): the negative control.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;

create temp table grant_contract_expected (kind text not null, line text not null) on commit drop;

insert into grant_contract_expected (kind, line) values
('col','blog_posts.category | anon | SELECT'),
('col','blog_posts.category | authenticated | SELECT'),
('col','blog_posts.content_markdown | anon | SELECT'),
('col','blog_posts.content_markdown | authenticated | SELECT'),
('col','blog_posts.cover_image_path | anon | SELECT'),
('col','blog_posts.cover_image_path | authenticated | SELECT'),
('col','blog_posts.created_at | anon | SELECT'),
('col','blog_posts.created_at | authenticated | SELECT'),
('col','blog_posts.excerpt | anon | SELECT'),
('col','blog_posts.excerpt | authenticated | SELECT'),
('col','blog_posts.featured | anon | SELECT'),
('col','blog_posts.featured | authenticated | SELECT'),
('col','blog_posts.id | anon | SELECT'),
('col','blog_posts.id | authenticated | SELECT'),
('col','blog_posts.published_at | anon | SELECT'),
('col','blog_posts.published_at | authenticated | SELECT'),
('col','blog_posts.seo_description | anon | SELECT'),
('col','blog_posts.seo_description | authenticated | SELECT'),
('col','blog_posts.seo_title | anon | SELECT'),
('col','blog_posts.seo_title | authenticated | SELECT'),
('col','blog_posts.slug | anon | SELECT'),
('col','blog_posts.slug | authenticated | SELECT'),
('col','blog_posts.status | anon | SELECT'),
('col','blog_posts.status | authenticated | SELECT'),
('col','blog_posts.title | anon | SELECT'),
('col','blog_posts.title | authenticated | SELECT'),
('col','blog_posts.updated_at | anon | SELECT'),
('col','blog_posts.updated_at | authenticated | SELECT'),
('col','book_reviews.author_id | authenticated | SELECT'),
('col','book_reviews.book_id | authenticated | SELECT'),
('col','book_reviews.book_title | authenticated | SELECT'),
('col','book_reviews.decided_at | authenticated | SELECT'),
('col','book_reviews.message_to_author | authenticated | SELECT'),
('col','book_reviews.reason | authenticated | SELECT'),
('col','book_reviews.status | authenticated | SELECT'),
('col','book_reviews.submitted_at | authenticated | SELECT'),
('col','book_takedowns.author_id | authenticated | SELECT'),
('col','book_takedowns.book_id | authenticated | SELECT'),
('col','book_takedowns.book_title | authenticated | SELECT'),
('col','book_takedowns.bundle_ids | authenticated | SELECT'),
('col','book_takedowns.lifted_at | authenticated | SELECT'),
('col','book_takedowns.message_to_author | authenticated | SELECT'),
('col','book_takedowns.reason | authenticated | SELECT'),
('col','book_takedowns.taken_down_at | authenticated | SELECT'),
('col','books.series_id | authenticated | UPDATE'),
('col','books.series_position | authenticated | UPDATE'),
('col','discount_codes.active | authenticated | UPDATE'),
('col','discount_codes.amount_off_all | authenticated | INSERT'),
('col','discount_codes.author_id | authenticated | INSERT'),
('col','discount_codes.book_id | authenticated | INSERT'),
('col','discount_codes.code | authenticated | INSERT'),
('col','discount_codes.expires_at | authenticated | INSERT'),
('col','discount_codes.id | authenticated | INSERT'),
('col','discount_codes.percent_off | authenticated | INSERT'),
('col','pen_names.bio | authenticated | UPDATE'),
('col','pen_names.links | authenticated | UPDATE'),
('col','pen_names.name | authenticated | UPDATE'),
('col','profiles.display_name | authenticated | UPDATE'),
('col','profiles.public_author_name | authenticated | UPDATE'),
('col','reviews.body | authenticated | UPDATE'),
('col','reviews.book_id | authenticated | UPDATE'),
('col','reviews.rating | authenticated | UPDATE'),
('col','reviews.reader_id | authenticated | UPDATE'),
('col','series.author_id | authenticated | INSERT'),
('col','series.pen_name_id | authenticated | INSERT'),
('col','series.title | authenticated | INSERT'),
('rel','r admin_audit_log | anon | -'),
('rel','r admin_audit_log | authenticated | -'),
('rel','r admin_audit_log | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r author_ledger_entries | anon | -'),
('rel','r author_ledger_entries | authenticated | SELECT'),
('rel','r author_ledger_entries | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r author_payout_destinations | anon | -'),
('rel','r author_payout_destinations | authenticated | SELECT'),
('rel','r author_payout_destinations | service_role | -'),
('rel','r author_payout_settings | anon | -'),
('rel','r author_payout_settings | authenticated | SELECT'),
('rel','r author_payout_settings | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r author_payouts | anon | -'),
('rel','r author_payouts | authenticated | SELECT'),
('rel','r author_payouts | service_role | SELECT'),
('rel','r blog_posts | anon | -'),
('rel','r blog_posts | authenticated | -'),
('rel','r blog_posts | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r book_checkout_intents | anon | -'),
('rel','r book_checkout_intents | authenticated | -'),
('rel','r book_checkout_intents | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r book_contributors | anon | SELECT'),
('rel','r book_contributors | authenticated | DELETE,INSERT,SELECT'),
('rel','r book_contributors | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r book_reports | anon | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r book_reports | authenticated | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r book_reports | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r book_reviews | anon | -'),
('rel','r book_reviews | authenticated | -'),
('rel','r book_reviews | service_role | SELECT'),
('rel','r book_rights_declarations | anon | -'),
('rel','r book_rights_declarations | authenticated | SELECT'),
('rel','r book_rights_declarations | service_role | INSERT,SELECT'),
('rel','r book_takedowns | anon | -'),
('rel','r book_takedowns | authenticated | -'),
('rel','r book_takedowns | service_role | SELECT'),
('rel','r book_views | anon | -'),
('rel','r book_views | authenticated | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r book_views | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r books | anon | -'),
('rel','r books | authenticated | DELETE,SELECT'),
('rel','r books | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_books | anon | SELECT'),
('rel','r bundle_books | authenticated | SELECT'),
('rel','r bundle_books | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_checkout_reader_holds | anon | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_checkout_reader_holds | authenticated | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_checkout_reader_holds | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_checkout_reservations | anon | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_checkout_reservations | authenticated | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_checkout_reservations | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundle_checkout_snapshots | anon | -'),
('rel','r bundle_checkout_snapshots | authenticated | -'),
('rel','r bundle_checkout_snapshots | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r bundles | anon | -'),
('rel','r bundles | authenticated | DELETE,SELECT'),
('rel','r bundles | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r discount_codes | anon | -'),
('rel','r discount_codes | authenticated | DELETE,SELECT'),
('rel','r discount_codes | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r payment_disputes | anon | -'),
('rel','r payment_disputes | authenticated | -'),
('rel','r payment_disputes | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r payment_events | anon | -'),
('rel','r payment_events | authenticated | SELECT'),
('rel','r payment_events | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r payment_refunds | anon | -'),
('rel','r payment_refunds | authenticated | SELECT'),
('rel','r payment_refunds | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r payments | anon | -'),
('rel','r payments | authenticated | SELECT'),
('rel','r payments | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r payout_destination_snapshots | anon | -'),
('rel','r payout_destination_snapshots | authenticated | -'),
('rel','r payout_destination_snapshots | service_role | -'),
('rel','r payout_minimum_policy | anon | -'),
('rel','r payout_minimum_policy | authenticated | -'),
('rel','r payout_minimum_policy | service_role | -'),
('rel','r payout_reversal | anon | -'),
('rel','r payout_reversal | authenticated | -'),
('rel','r payout_reversal | service_role | -'),
('rel','r payout_runs | anon | -'),
('rel','r payout_runs | authenticated | -'),
('rel','r payout_runs | service_role | SELECT'),
('rel','r pen_name_follows | anon | -'),
('rel','r pen_name_follows | authenticated | DELETE,INSERT,SELECT'),
('rel','r pen_name_follows | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r pen_names | anon | -'),
('rel','r pen_names | authenticated | SELECT'),
('rel','r pen_names | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r pok_book_checkout_orders | anon | -'),
('rel','r pok_book_checkout_orders | authenticated | -'),
('rel','r pok_book_checkout_orders | service_role | INSERT,SELECT,UPDATE'),
('rel','r profiles | anon | -'),
('rel','r profiles | authenticated | SELECT'),
('rel','r profiles | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r purchases | anon | -'),
('rel','r purchases | authenticated | SELECT'),
('rel','r purchases | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r refund_issuance_attempts | anon | -'),
('rel','r refund_issuance_attempts | authenticated | -'),
('rel','r refund_issuance_attempts | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r refund_request_items | anon | -'),
('rel','r refund_request_items | authenticated | SELECT'),
('rel','r refund_request_items | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r refund_requests | anon | -'),
('rel','r refund_requests | authenticated | SELECT'),
('rel','r refund_requests | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r reviews | anon | -'),
('rel','r reviews | authenticated | INSERT,SELECT'),
('rel','r reviews | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r series | anon | -'),
('rel','r series | authenticated | DELETE,SELECT'),
('rel','r series | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r staff_members | anon | -'),
('rel','r staff_members | authenticated | SELECT'),
('rel','r staff_members | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r wishlist_items | anon | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r wishlist_items | authenticated | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','r wishlist_items | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v author_book_purchases | anon | -'),
('rel','v author_book_purchases | authenticated | SELECT'),
('rel','v author_book_purchases | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v author_bundle_sales | anon | -'),
('rel','v author_bundle_sales | authenticated | SELECT'),
('rel','v author_bundle_sales | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v public_books | anon | SELECT'),
('rel','v public_books | authenticated | SELECT'),
('rel','v public_books | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v public_bundles | anon | SELECT'),
('rel','v public_bundles | authenticated | SELECT'),
('rel','v public_bundles | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v public_pen_names | anon | SELECT'),
('rel','v public_pen_names | authenticated | SELECT'),
('rel','v public_pen_names | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v public_reviews | anon | SELECT'),
('rel','v public_reviews | authenticated | SELECT'),
('rel','v public_reviews | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v public_series | anon | SELECT'),
('rel','v public_series | authenticated | SELECT'),
('rel','v public_series | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v reader_bundle_purchases | anon | -'),
('rel','v reader_bundle_purchases | authenticated | SELECT'),
('rel','v reader_bundle_purchases | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
('rel','v reader_refund_requests | anon | -'),
('rel','v reader_refund_requests | authenticated | SELECT'),
('rel','v reader_refund_requests | service_role | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE');

create temp table grant_contract_live on commit drop as
select 'rel'::text as kind,
       c.relkind::text || ' ' || c.relname || ' | ' || r.rolname || ' | ' ||
       coalesce((select string_agg(a.privilege_type, ',' order by a.privilege_type)
                 from aclexplode(c.relacl) a
                 where a.grantee = r.oid and a.privilege_type <> 'MAINTAIN'), '-') as line
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (select oid, rolname from pg_roles
            where rolname in ('anon', 'authenticated', 'service_role')) r
where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S', 'p')
union all
select 'col', c.relname || '.' || att.attname || ' | ' || r.rolname || ' | ' ||
       string_agg(a.privilege_type, ',' order by a.privilege_type)
from pg_attribute att
join pg_class c on c.oid = att.attrelid
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(att.attacl) a
join pg_roles r on r.oid = a.grantee
where n.nspname = 'public' and att.attacl is not null
  and r.rolname in ('anon', 'authenticated', 'service_role')
group by c.relname, att.attname, r.rolname;

-- part1: the snapshot, both directions.
do $$
declare
  v_expected int;
  v_diff text;
begin
  select count(*) into v_expected from grant_contract_expected;
  if v_expected <> 213 then
    raise exception 'FAIL: part1: the snapshot must hold 213 rows, holds %', v_expected;
  end if;

  select string_agg(side || ' ' || kind || ' ' || line, E'\n' order by side, kind, line)
    into v_diff
    from (select 'only_in_database:' as side, kind, line
            from (select kind, line from grant_contract_live
                  except
                  select kind, line from grant_contract_expected) a
          union all
          select 'only_in_snapshot:', kind, line
            from (select kind, line from grant_contract_expected
                  except
                  select kind, line from grant_contract_live) b) d;

  if v_diff is not null then
    raise exception E'FAIL: part1: Data API grants differ from the snapshot:\n%\n'
      'a new table/view needs explicit revoke + grant lines; update this snapshot only on purpose',
      v_diff;
  end if;
end $$;

-- part2: anon holds nothing on the private base tables. Checks the
-- EFFECTIVE privilege (has_table_privilege / has_any_column_privilege),
-- so a grant to PUBLIC or to a role anon is a member of counts too.
do $$
declare
  v_rel text;
  v_priv text;
  v_held text;
begin
  foreach v_rel in array array['pen_names', 'books', 'profiles', 'purchases', 'payments'] loop
    if to_regclass('public.' || v_rel) is null then
      raise exception 'FAIL: part2: public.% is missing', v_rel;
    end if;

    v_held := null;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                  'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege('anon', ('public.' || v_rel)::regclass, v_priv) then
        v_held := concat_ws(',', v_held, v_priv);
      end if;
    end loop;
    if v_held is not null then
      raise exception 'FAIL: part2: anon must hold no privilege on public.%, holds %', v_rel, v_held;
    end if;

    if has_any_column_privilege('anon', ('public.' || v_rel)::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'FAIL: part2: anon must hold no column privilege on public.%', v_rel;
    end if;
  end loop;
end $$;

-- part3: nothing in public is granted to PUBLIC (every role, anon
-- included); part1 only reads the three named roles.
do $$
declare
  v_diff text;
begin
  select string_agg(line, E'\n' order by line)
    into v_diff
    from (select c.relkind::text || ' ' || c.relname || ' | PUBLIC | ' || a.privilege_type as line
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            cross join lateral aclexplode(c.relacl) a
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S', 'p')
             and a.grantee = 0
          union all
          select c.relname || '.' || att.attname || ' | PUBLIC | ' || a.privilege_type
            from pg_attribute att
            join pg_class c on c.oid = att.attrelid
            join pg_namespace n on n.oid = c.relnamespace
            cross join lateral aclexplode(att.attacl) a
           where n.nspname = 'public' and att.attacl is not null
             and a.grantee = 0) g;

  if v_diff is not null then
    raise exception E'FAIL: part3: tables, views and columns in public must not be granted to PUBLIC:\n%', v_diff;
  end if;
end $$;

rollback;
