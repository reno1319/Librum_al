// B2 (Codex advisory, 17 Oct): the account name becomes the public author
// name and the default pen name when a reader becomes an author, and both
// of those are capped at 120 characters in the database
// (profiles.public_author_name, pen_names.name). The account name itself
// had no cap, so a longer one could never become an author. Sign-up and
// the profile page now refuse more than this. JavaScript's .length counts
// UTF-16 units, never fewer than Postgres's char_length, so a name that
// passes here always fits there.
export const ACCOUNT_NAME_MAX_LENGTH = 120;

export const ACCOUNT_NAME_TOO_LONG_MESSAGE = `Emri mund të ketë deri në ${ACCOUNT_NAME_MAX_LENGTH} karaktere`;
