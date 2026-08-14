export const GENRES = [
  "Fiction",
  "Non-Fiction",
  "Mystery & Thriller",
  "Romance",
  "Fantasy",
  "Science Fiction",
  "Horror",
  "Biography & Memoir",
  "Self-Help",
  "History",
  "Poetry",
  "Young Adult",
  "Children's",
  "Business",
] as const;

export type Genre = (typeof GENRES)[number];
