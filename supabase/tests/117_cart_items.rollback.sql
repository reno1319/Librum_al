-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for the cart (supabase/migrations/20261125130000_cart_items.sql).
-- Drops the cart table (and with it its policies, indexes and trigger)
-- and its two functions. Nothing else uses them. Readers' saved carts
-- are lost; no purchase, order or gift is touched (none exist here).

begin;

drop table public.cart_items;
drop function public.cart_items_limit();
drop function public.cart_book_allowed(uuid, boolean);

commit;
