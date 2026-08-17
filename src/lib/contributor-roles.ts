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
  "Co-Author": "Co-authored by",
  Illustrator: "Illustrated by",
  Translator: "Translated by",
  Narrator: "Narrated by",
  Editor: "Edited by",
  Foreword: "Foreword by",
  "Cover Designer": "Cover by",
};
