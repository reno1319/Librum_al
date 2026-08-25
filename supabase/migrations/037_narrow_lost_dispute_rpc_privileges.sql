-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LAUNCH-1 P2-2: closes the excess-privilege finding from the
-- P1-12 remaining-launch-blocker audit -- two SECURITY DEFINER RPCs
-- introduced by migrations 035/036, payment_intent_has_lost_dispute(text)
-- and lost_disputed_payment_intents(text[]), were both directly
-- EXECUTE-granted to `authenticated` even though neither legitimate use
-- needs that: the first has no direct application caller at all (every
-- use is internal, from inside user_owns_book(), create_book_checkout_
-- intent(), and finalize_book_checkout_intent() -- all three themselves
-- SECURITY DEFINER), and the second's one legitimate caller (the Sales
-- dashboard) always already scopes its own input to the calling
-- author's own books/bundles before ever calling it -- a property of
-- that ONE caller, not of the function's own grant, which happily
-- accepts an arbitrary text[] from ANY authenticated session. See the
-- P2-2 audit/design report for the full trace (every call site
-- inventoried, Options A-D compared, SECURITY DEFINER nested-call
-- semantics empirically verified against a disposable local Postgres
-- instance rather than assumed) -- summarized here only where it
-- explains a specific choice made in this file.
--
-- Approved design (Option C): replace the caller-supplied-id RPC with a
-- zero-argument, auth.uid()-scoped RPC that re-derives its own
-- candidate payment-intent set server-side, identically to what the
-- Sales page already computed client-side -- so the authorization
-- boundary becomes a structural property of the function itself, never
-- a property of "the caller happened to filter its input first." The
-- target invariant this closes: an authenticated user must not be able
-- to ask arbitrary questions about an unrelated Stripe payment intent,
-- and no public RPC's authorization may rest on payment_intent_id
-- secrecy.
--
-- If you're setting up a fresh project, just run schema.sql instead --
-- it already includes all of this.

-- ============================================================
-- author_lost_disputed_payment_intents(): the Sales dashboard's new,
-- sole way to learn which of ITS OWN CALLER's payment intents are
-- lost-disputed. Takes no parameters at all -- there is nothing for a
-- caller to misuse, unlike lost_disputed_payment_intents(text[])'s
-- arbitrary array below (dropped by this same migration). The
-- candidate set is built the same way the Sales page's own
-- collectDistinctPaymentIntentIds() used to build it client-side (see
-- src/app/dashboard/sales/page.tsx, revenue-logic.ts): the UNION of
-- (a) this author's own purchases rows, scoped via the same books.
-- author_id join "Authors can view purchases of their own books"
-- already uses, and (b) this author's own fulfilled bundle_checkout_
-- snapshots rows, scoped via the same author_id = auth.uid() column
-- "Authors can view their own fulfilled bundle snapshot transactions"
-- already uses -- both conditions are simply restated here in SQL
-- rather than reconstructed by the caller, so the scoping is now
-- structurally guaranteed rather than merely conventional.
--
-- Same SECURITY DEFINER / empty search_path / stable posture as its
-- two predecessors -- payment_disputes remains fully closed to anon/
-- authenticated (migration 035), so a request-scoped client still
-- cannot read it directly; this function is the one narrow, correctly-
-- scoped window into it for an author's own dashboard.
-- ============================================================
create or replace function public.author_lost_disputed_payment_intents()
returns table (stripe_payment_intent_id text)
language sql
security definer
set search_path = ''
stable
as $$
  with author_payment_intents as (
    select p.stripe_payment_intent_id
    from public.purchases p
    join public.books b on b.id = p.book_id
    where b.author_id = auth.uid()
      and p.stripe_payment_intent_id is not null
    union
    select s.stripe_payment_intent_id
    from public.bundle_checkout_snapshots s
    where s.author_id = auth.uid()
      and s.fulfilled_at is not null
      and s.stripe_payment_intent_id is not null
  )
  select distinct d.stripe_payment_intent_id
  from public.payment_disputes d
  where d.status = 'lost'
    and d.stripe_payment_intent_id in (select stripe_payment_intent_id from author_payment_intents);
$$;

revoke all on function public.author_lost_disputed_payment_intents() from public;
revoke all on function public.author_lost_disputed_payment_intents() from anon;
revoke all on function public.author_lost_disputed_payment_intents() from authenticated;
grant execute on function public.author_lost_disputed_payment_intents() to authenticated;

-- ============================================================
-- payment_intent_has_lost_dispute(text): unchanged definition (the
-- P2-2 audit found no reason to touch its body -- it remains the one
-- canonical "is this exact payment intent's dispute lost" predicate,
-- explicitly parameterized so it keeps working from contexts where
-- auth.uid() is not the relevant identity, most notably finalize_book_
-- checkout_intent's service-role webhook path acting on an explicit
-- reader_id). Only its grant changes: `authenticated` never had a
-- legitimate direct caller (verified by full repository search in the
-- P2-2 audit -- every one of its six call sites is another SQL
-- function's own body, never a `.rpc()` call from application code),
-- so the grant is removed outright rather than narrowed.
--
-- Its three internal callers (user_owns_book(), create_book_checkout_
-- intent(), finalize_book_checkout_intent()) keep working unchanged --
-- all four functions are SECURITY DEFINER, created by the same
-- migration-applying role, so a nested call from inside one executes
-- with that shared owner's own implicit EXECUTE privilege, never with
-- the original caller's. Verified empirically in the P2-2 design audit
-- (a disposable local Postgres repro: a fully-authenticated-revoked
-- helper, called from inside a SECURITY DEFINER wrapper granted to
-- authenticated, succeeds when the wrapper is called as authenticated
-- and fails only when the helper itself is called directly) rather
-- than assumed from general Postgres knowledge alone -- re-verified
-- again in this schema by this migration's own committed test suite
-- (supabase/tests/037_narrow_lost_dispute_rpc_privileges.test.sql).
--
-- No compensating grant to service_role either -- nothing in this
-- application ever calls this function via a service-role RPC (the
-- webhook's only RPC call is finalize_book_checkout_intent itself, per
-- the P2-2 audit's own repository search), so there is no legitimate
-- caller left to compensate for. public/anon were already revoked by
-- migration 035 and remain so -- restated here anyway, matching this
-- schema's own established convention (see migration 036's comment on
-- finalize_book_checkout_intent's unchanged grants) for a reader of
-- this file alone to see the complete, correct privilege model without
-- cross-referencing migration 035.
-- ============================================================
revoke all on function public.payment_intent_has_lost_dispute(text) from public;
revoke all on function public.payment_intent_has_lost_dispute(text) from anon;
revoke all on function public.payment_intent_has_lost_dispute(text) from authenticated;

-- ============================================================
-- lost_disputed_payment_intents(text[]): dropped outright, not merely
-- revoked. Its one legitimate caller (the Sales dashboard) is fully
-- superseded by author_lost_disputed_payment_intents() above; the
-- P2-2 audit's repository-wide search found no other caller, present
-- or planned (including src/app/admin/**, which never queries
-- payment_disputes or calls either dispute-membership RPC). Leaving it
-- defined-but-ungranted would be a live footgun -- a future migration
-- could re-grant it without ever re-deriving why that grant was unsafe
-- in the first place. Dropping it removes the arbitrary-payment-
-- intent-id surface from the schema entirely, not just from
-- `authenticated`'s reach.
-- ============================================================
drop function public.lost_disputed_payment_intents(text[]);
