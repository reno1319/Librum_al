export const CONTRIBUTOR_ROLES = [
  "Co-Author",
  "Illustrator",
  "Translator",
  "Narrator",
  "Editor",
  "Foreword",
  "Cover Designer",
] as const;

export type ContributorRole = (typeof CONTRIBUTOR_ROLES)[number];

// How each role reads as a credit line on the book page, e.g. "Illustrated by Jane Doe".
export const CONTRIBUTOR_ROLE_VERB: Record<ContributorRole, string> = {
  "Co-Author": "Bashkautor:",
  Illustrator: "Ilustrimet:",
  Translator: "Përkthimi:",
  Narrator: "Lexuar nga",
  Editor: "Redaktimi:",
  Foreword: "Parathënia:",
  "Cover Designer": "Kopertina:",
};

// ALBANIAN-9: the role names an author sees. The stored value stays the
// English key above (book_contributors.role and addContributor()'s check
// read it); only the label shown is Albanian.
export const CONTRIBUTOR_ROLE_LABELS: Record<ContributorRole, string> = {
  "Co-Author": "Bashkautor",
  Illustrator: "Ilustrues",
  Translator: "Përkthyes",
  Narrator: "Lexues (audio)",
  Editor: "Redaktor",
  Foreword: "Autor i parathënies",
  "Cover Designer": "Dizajner i kopertinës",
};

export function contributorRoleLabel(role: string): string {
  return CONTRIBUTOR_ROLE_LABELS[role as ContributorRole] ?? role;
}
