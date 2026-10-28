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
