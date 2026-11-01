// ALBANIAN-14 (Renato 10-28, "3. b"): the "Last updated" date of the
// Terms, the Privacy Policy and the Refund Policy, typed in one place.
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
export const PRIVACY_LAST_UPDATED = "1 nëntor 2026";

export const PRIVACY_LAST_UPDATED_LINE = `Përditësuar më: ${PRIVACY_LAST_UPDATED}`;
