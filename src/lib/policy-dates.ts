// ALBANIAN-14 (Renato 10-28, "3. b"): the "Last updated" date of the
// Terms, the Privacy Policy and the Refund Policy, typed in one place
// (since BD4 and BD2, Privacy and Terms have their own dates below).
// It must be the exact day the Albanian text goes live on Production.
// POL-1 (Renato 10-29, "1. a"): release 9 goes to Production on Friday
// 30 October 2026, Tirana time. If the release moves to another day,
// this line changes with it before the release.
export const POLICY_LAST_UPDATED = "30 tetor 2026";

export const POLICY_LAST_UPDATED_LINE = `Përditësuar më: ${POLICY_LAST_UPDATED}`;

// BD4 (Renato 1 Nov, "3. a"): the Privacy Policy has its own date from
// now on, so a Privacy change no longer moves the Terms and Refunds
// dates. Like the line above, it must be the day this Privacy text goes
// live on Production: the release that ships it sets the final value.
// BD7 (Renato 1 Nov, card "b"): the release goes to Production on
// Monday 2 November 2026; if it moves, this line moves with it.
export const PRIVACY_LAST_UPDATED = "2 nëntor 2026";

export const PRIVACY_LAST_UPDATED_LINE = `Përditësuar më: ${PRIVACY_LAST_UPDATED}`;

// BD2 (Renato 1 Nov, "3. a"): the Terms have their own date from now on
// (royalty wording, TERMS_VERSION "terms-sq-2"), so the Refund Policy
// keeps POLICY_LAST_UPDATED. Like the lines above, it must be the day
// this Terms text goes live on Production: the release that ships it
// (BD7) sets the final value.
// BD7 (Renato 1 Nov, card "b"): release day Monday 2 November 2026.
export const TERMS_LAST_UPDATED = "2 nëntor 2026";

export const TERMS_LAST_UPDATED_LINE = `Përditësuar më: ${TERMS_LAST_UPDATED}`;
