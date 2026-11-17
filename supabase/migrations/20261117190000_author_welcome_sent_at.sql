-- AUTHOR-EMAILS (Renato 11-17, mail2 b + mail3 a): Librum's own welcome
-- email for authors goes once per account. The app claims this column
-- (set where still null, as the service role) before sending, so a double
-- click or two tabs never send twice.
--
-- Accounts that are already authors are marked as welcomed, so nobody
-- who signed up before this change gets one. Readers stay null: a reader
-- who becomes an author later gets the author welcome then (mail3 a).
--
-- No grant changes: `authenticated` may update only display_name, bio and
-- public_author_name (column grants, migrations 033/046), so a signed-in
-- user can't write this column; SELECT stays own row + staff (046 RLS).

alter table public.profiles
  add column author_welcome_sent_at timestamptz;

update public.profiles
  set author_welcome_sent_at = now()
  where role = 'author';
