-- SECURITY-9B (pipeline item 9, part b; Renato's answers 2026-10-24,
-- "5. a" and "6. a"): grants tightening. Privileges only: no table,
-- column, row, policy or function body changes.
--
-- ROLLOUT ORDER. Either order with the application: the application
-- does not change, and every privilege it uses is kept (checked against
-- each .from()/.rpc() call; see the patch report). Independent of
-- SECURITY-9A. Run AS postgres (the migration role): section 3 sets
-- postgres's own default privileges. Production gets it only at a
-- release, through the authorized route.

-- 1. The five tables RLS guarded alone. anon held every privilege
--    (TRUNCATE included) on four of them, and authenticated on all five.
--    RLS stays on and unchanged; the grants now match what each table's
--    policies allow, nothing more. service_role is unchanged.
--      wishlist_items  authenticated: SELECT, INSERT, DELETE (its three
--                      own-row policies; the wishlist page and the two
--                      book-page actions)
--      book_reports    authenticated: SELECT (staff with reports.view),
--                      INSERT (a signed-in reader reports a book)
--      book_views      authenticated: SELECT (an author's own counts);
--                      rows are written by the service role
--      bundle_checkout_reservations, bundle_checkout_reader_holds:
--                      nothing (no policy; only the service role and
--                      SECURITY DEFINER functions touch them)
revoke all on table
  public.wishlist_items,
  public.book_reports,
  public.book_views,
  public.bundle_checkout_reservations,
  public.bundle_checkout_reader_holds
  from public, anon, authenticated;

grant select, insert, delete on table public.wishlist_items to authenticated;
grant select, insert on table public.book_reports to authenticated;
grant select on table public.book_views to authenticated;

-- 2. Functions: service_role's EXECUTE written out. On staging and
--    Production these 55 functions give service_role EXECUTE only
--    through the platform's old default privileges; a rebuild without
--    that default would lose it (a service-role read of public_books
--    calls user_owns_book(), for one). Mirror only for 53 of them: staging already holds each.
--    The other two are the opposite case: test 037 requires service_role
--    NOT to hold EXECUTE on them (no service-role caller exists), but
--    staging's old default gave it anyway, so it is revoked here.
revoke all on function public.payment_intent_has_lost_dispute(text) from service_role;
revoke all on function public.author_lost_disputed_payment_intents() from service_role;
grant execute on function public.add_staff_member_by_email(text,text) to service_role;
grant execute on function public.begin_refund_issuance_attempt(uuid,text) to service_role;
grant execute on function public.books_enforce_pen_name() to service_role;
grant execute on function public.bundle_books_enforce_pen_name() to service_role;
grant execute on function public.bundles_check_member_pen_names() to service_role;
grant execute on function public.bundles_enforce_pen_name() to service_role;
grant execute on function public.cancel_refund_request(uuid) to service_role;
grant execute on function public.change_staff_role(uuid,text) to service_role;
grant execute on function public.clear_expired_book_reservations() to service_role;
grant execute on function public.clear_expired_reader_holds() to service_role;
grant execute on function public.complete_refund_issuance_attempt(uuid,text,text) to service_role;
grant execute on function public.create_blog_post(text,text,text,text,text,text,boolean,text,text) to service_role;
grant execute on function public.create_book_checkout_intent(uuid,text,boolean,uuid) to service_role;
grant execute on function public.create_bundle_checkout_snapshot(uuid,text,text,integer) to service_role;
grant execute on function public.delete_blog_post(uuid) to service_role;
grant execute on function public.enforce_book_checkout_intents_transition_rules() to service_role;
grant execute on function public.enforce_pok_book_checkout_orders_transition_rules() to service_role;
grant execute on function public.fail_refund_issuance_attempt(uuid,text) to service_role;
grant execute on function public.get_author_financial_summary() to service_role;
grant execute on function public.get_author_payout_overview() to service_role;
grant execute on function public.get_book_checkout_quote(uuid,uuid) to service_role;
grant execute on function public.get_finance_summary_counts() to service_role;
grant execute on function public.handle_new_user() to service_role;
grant execute on function public.is_admin() to service_role;
grant execute on function public.list_admin_audit_events(text,uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid,integer) to service_role;
grant execute on function public.list_author_financial_activity(integer,timestamp with time zone,uuid) to service_role;
grant execute on function public.list_author_payout_history(integer,timestamp with time zone,uuid) to service_role;
grant execute on function public.list_payout_batch_export(uuid) to service_role;
grant execute on function public.list_purchase_currencies(uuid[]) to service_role;
grant execute on function public.list_refund_request_currencies(uuid[]) to service_role;
grant execute on function public.list_staff_members() to service_role;
grant execute on function public.pen_name_follows_refuse_own() to service_role;
grant execute on function public.pen_names_after_update() to service_role;
grant execute on function public.pen_names_before_delete() to service_role;
grant execute on function public.pen_names_sync_profile_default() to service_role;
grant execute on function public.publish_blog_post(uuid) to service_role;
grant execute on function public.refund_reconciliation_rows() to service_role;
grant execute on function public.remove_staff_member(uuid) to service_role;
grant execute on function public.request_refund(text,text) to service_role;
grant execute on function public.review_book_report(uuid,text,text) to service_role;
grant execute on function public.review_refund_request(uuid,text,text) to service_role;
grant execute on function public.search_books(text,text,integer,integer,integer) to service_role;
grant execute on function public.series_enforce_pen_name() to service_role;
grant execute on function public.set_author_payout_destination(text,text,text) to service_role;
grant execute on function public.set_author_payout_threshold(text,bigint) to service_role;
grant execute on function public.set_pok_book_checkout_order_updated_at() to service_role;
grant execute on function public.staff_has_permission(text) to service_role;
grant execute on function public.staff_members_protect_last_owner() to service_role;
grant execute on function public.staff_profile_display_names(uuid[]) to service_role;
grant execute on function public.staff_remove_pen_name_links(uuid) to service_role;
grant execute on function public.unpublish_blog_post(uuid) to service_role;
grant execute on function public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text) to service_role;
grant execute on function public.user_owns_book(uuid) to service_role;

-- 3. Closed by default from now on: a table, view, sequence or function
--    that a later migration creates (as postgres, the migration role)
--    gets NO privilege for anon, authenticated or service_role until
--    that migration grants it on purpose. Objects that exist now keep
--    every privilege they have. The platform role supabase_admin's own
--    defaults are not ours to change and stay as they are.
--    PUBLIC: PostgreSQL's own EXECUTE-for-PUBLIC default on new
--    functions is global (a per-schema default cannot remove it), and it
--    is left on purpose: a global revoke would also hit every function
--    postgres creates in any other schema. Each function revokes PUBLIC
--    itself (the project rule), and test 082 fails if anon can EXECUTE
--    any public function outside its fixed list.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;
