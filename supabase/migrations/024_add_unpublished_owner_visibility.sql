-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Lets a reader who legitimately owns a book keep viewing its
-- detail page after the author unpublishes it (see the Phase 8/8A
-- audit's approved decision: existing owners retain access, refunded
-- former buyers and unrelated users do not).
--
-- WHY A HELPER FUNCTION, NOT A DIRECT POLICY: the obvious approach --
-- adding a "books" SELECT policy with an inline
-- "exists (select 1 from purchases where ...)" -- was evaluated and
-- rejected. purchases already has a SELECT policy
-- ("Authors can view purchases of their own books") that queries
-- books. Adding a books policy that queries purchases the other
-- direction would close that into a genuine two-table RLS cycle:
-- evaluating the new books policy requires applying purchases' RLS,
-- one of whose own policies requires applying books' RLS right back --
-- including, for the row involved, the very policy being evaluated.
-- This is a real, documented Postgres RLS pitfall for mutual
-- cross-table policy references, not just same-table self-reference.
--
-- A SECURITY DEFINER function breaks the cycle: it executes its
-- internal query as the function's owner, which bypasses purchases'
-- RLS entirely (table owners bypass RLS by default; no
-- FORCE ROW LEVEL SECURITY is set on purchases, consistent with every
-- other table in this schema) -- so calling it from a books policy
-- never re-enters purchases' policies, and there is nothing for a
-- books policy to recurse back into.
--
-- Returns ONLY true/false -- never a purchase row, amount, Stripe id,
-- or reader id. Takes no reader_id parameter -- always uses auth.uid()
-- internally, so a caller can only ever ask "do I own this," never
-- "does someone else."

create or replace function public.user_owns_book(target_book_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.purchases
    where purchases.book_id = target_book_id
      and purchases.reader_id = auth.uid()
      and purchases.refunded_at is null
  );
$$;

-- EXECUTE is restricted to authenticated only -- an anonymous visitor
-- has no auth.uid() to own anything with, so there is no reason to
-- grant it access at all.
revoke all on function public.user_owns_book(uuid) from public;
revoke all on function public.user_owns_book(uuid) from anon;
revoke all on function public.user_owns_book(uuid) from authenticated;
grant execute on function public.user_owns_book(uuid) to authenticated;

-- A SEPARATE policy, not a change to the existing
-- "Published books are viewable by everyone, drafts by their author"
-- policy -- that policy stays exactly as it was (applies to every
-- role, published-or-own-author only). This new policy is additional
-- and additive: Postgres combines multiple permissive SELECT policies
-- on the same table with OR, so the effective visibility becomes
-- "published, or own author, or legitimately acquired" -- without
-- touching the existing policy's own logic or its role scope.
create policy "Owners can view books they've acquired"
  on public.books for select
  to authenticated
  using (public.user_owns_book(books.id));
