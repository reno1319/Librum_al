-- LOCAL/DISPOSABLE use in the 086 harness; the same file is the reviewed rollback for the database plan.
-- BD3-P3 rollback for migration 20261101150000_bd3_rights_public_domain_original.sql
-- Puts the two-value basis CHECK back. Refuses (and changes nothing) if
-- any 'public_domain_original' declaration exists: those rows are
-- append-only legal records and are never rewritten or deleted. Run the
-- app rollback (previous deploy) FIRST, so nothing writes the third
-- value while this runs.
begin;

lock table public.book_rights_declarations in share row exclusive mode;

do $$
declare
  n bigint;
begin
  select count(*) into n
    from public.book_rights_declarations
   where basis = 'public_domain_original';
  if n > 0 then
    raise exception 'rollback refused: % public_domain_original declaration(s) exist (append-only records)', n;
  end if;
end;
$$;

alter table public.book_rights_declarations
  drop constraint book_rights_declarations_basis_check,
  add constraint book_rights_declarations_basis_check
    check (basis in ('own_rights', 'public_domain'));

commit;
