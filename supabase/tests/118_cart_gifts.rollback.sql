-- LOCAL/DISPOSABLE DATABASE OR A PLANNED, APPROVED ROLLBACK ONLY.
--
-- Undoes supabase/migrations/20261125140000_cart_gifts.sql: drops the ten
-- gift functions, then the table. The purchases rows of claimed gifts
-- STAY (they are the friends' books). Code goes back first: the claim
-- page, the Library and the change-email page read these.

begin;
drop function if exists public.gift_cancel_send(uuid, text);
drop function if exists public.gift_confirm_send(uuid, text);
drop function if exists public.gift_change_email(uuid, text);
drop function if exists public.gift_resend(uuid);
drop function if exists public.gift_for_send(uuid);
drop function if exists public.claim_gift(text);
drop function if exists public.gift_preview(text);
drop function if exists public.gift_buyer_first_name(uuid);
drop function if exists public.gift_new_token();
drop function if exists public.gift_token_hash(text);
drop table if exists public.gifts;
commit;
