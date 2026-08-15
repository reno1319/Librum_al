export type Role = "author" | "reader";

export type Profile = {
  id: string;
  role: Role;
  display_name: string;
  bio: string | null;
  avatar_path: string | null;
  created_at: string;
};

export type BookStatus = "draft" | "published";

export type Book = {
  id: string;
  author_id: string;
  title: string;
  description: string;
  preview_text: string;
  genre: string | null;
  price_cents: number;
  cover_path: string | null;
  file_path: string | null;
  status: BookStatus;
  created_at: string;
  updated_at: string;
};

export type Review = {
  id: string;
  book_id: string;
  reader_id: string;
  rating: number;
  body: string;
  created_at: string;
};
