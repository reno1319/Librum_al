-- BD3-P3 (Renato 2026-11-01, "2a"): a third rights basis an author can
-- declare for a book, 'public_domain_original' -- the original work is
-- in the public domain and the translation is the author's own (or
-- they have the translator's permission). The download's Librum
-- copyright page then gives "©" for the translation only.
--
-- WHAT CHANGES (one table, one constraint, no data):
--   book_rights_declarations_basis_check (the name Postgres gave the
--   inline CHECK in 20261018091237) is dropped and added back, same
--   name, accepting the two existing values plus the new one.
--
-- No row is updated: the table is append-only (its trigger refuses
-- changes), every existing row holds one of the two old values, and the
-- new CHECK accepts both. Nothing else reads the values in SQL: no
-- function, view or policy compares basis. RLS, grants, the append-only
-- trigger and the index are untouched.
--
-- ROLLBACK (supabase/tests/086_bd3_rights_public_domain_original.rollback.sql,
-- proven by the 086 harness): put the
-- two-value CHECK back. It refuses -- and changes nothing -- if
-- any 'public_domain_original' declaration exists, because those rows
-- are append-only legal records and must not be rewritten or deleted.

-- One statement (audit r1, N4): atomic even outside a transaction, so
-- the table is never left without a basis CHECK.
alter table public.book_rights_declarations
  drop constraint book_rights_declarations_basis_check,
  add constraint book_rights_declarations_basis_check
    check (basis in ('own_rights', 'public_domain', 'public_domain_original'));
