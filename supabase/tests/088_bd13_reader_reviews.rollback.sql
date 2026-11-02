-- BD13 ROLLBACK: puts reader reviews back to how they worked before
-- migration 20261102120000, for use only together with the app revert
-- (the BD13 commit):
--   * authenticated gets INSERT and UPDATE on (book_id, reader_id,
--     rating, body) of public.reviews back, so the reverted
--     submitReview()'s direct upsert works again -- column-level, so
--     status and reviewer_is_author stay unwritable for readers;
--   * public.public_reviews is deliberately left as BD13 made it:
--     approved reviews only, the chosen name only, the badge. Putting
--     the old body back would make every pending and rejected review
--     (including ones rejected for personal data or abuse) public
--     (audit r1 R2). The reverted app reads only the old columns, which
--     the view still has;
--   * reviews.status defaults to 'approved' again, so a review the
--     reverted app saves is consistent with the old "everything shows"
--     behaviour;
--   * the five BD13 functions are dropped.
--
-- Deliberately NOT removed: profiles.review_name, the reviews columns
-- status, rejection_reason, rejection_note, updated_at,
-- reviewer_is_author, their CHECKs and
-- reviews_pending_idx. Nullable or defaulted columns the reverted app
-- never reads are the safer state, and nothing a reader or staff member
-- typed is lost. No row is changed.
--
-- Known limits after a rollback:
--   * Pending and rejected reviews stay hidden. A review the reverted
--     app saves gets status 'approved' (the default) and shows; an edit
--     it makes keeps the row's status, so a pending or rejected review
--     the reader edits stays hidden (there is no queue after a
--     rollback; staff can approve it by hand). Reviews by authors no longer show
--     their default pen name (the pre-BD13 rule): they show the chosen
--     review name or "Një lexues i Librum".
--   * The live database keeps the columns while the reverted
--     supabase/schema.sql no longer mentions them; the next migration
--     must start from the live state.
--   * The forward migration cannot be re-run as is (ADD COLUMN would
--     fail on the existing columns).
--
-- Safe to run more than once.

set client_min_messages = warning;

-- Column-level INSERT only (audit r4 N1): the reverted submitReview()
-- upserts exactly (book_id, reader_id, rating, body), so a reader still
-- cannot write status or reviewer_is_author after a rollback. The
-- revoke first makes a second run identical.
revoke insert on public.reviews from authenticated;
grant insert (book_id, reader_id, rating, body)
  on public.reviews
  to authenticated;
grant update (book_id, reader_id, rating, body)
  on public.reviews
  to authenticated;

alter table public.reviews alter column status set default 'approved';

drop function if exists public.submit_reader_review(uuid, integer, text, text);
drop function if exists public.staff_list_pending_reader_reviews();
drop function if exists public.staff_approve_reader_review(uuid, timestamptz);
drop function if exists public.staff_reject_reader_review(uuid, timestamptz, text, text);
drop function if exists public.staff_set_review_name(uuid, text);
