-- ROLLBACK for migration 20261123190000_blog_post_reactions.sql.
-- LOCAL/DISPOSABLE DATABASE TEST, or a deliberate rollback only.
-- Lossy: every reaction is dropped with the table. Revert the app first
-- (the old app never calls these). Safe to run twice.

begin;

drop function if exists public.toggle_blog_post_reaction(uuid, text);
drop function if exists public.blog_post_reaction_counts(uuid[]);
drop table if exists public.blog_post_reactions;

commit;
