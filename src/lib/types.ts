export type Role = "author" | "reader";

export type Profile = {
  id: string;
  role: Role;
  display_name: string;
  created_at: string;
};

export type BookStatus = "draft" | "published";

export type Book = {
  id: string;
  author_id: string;
  title: string;
  description: string;
  genre: string | null;
  price_cents: number;
  cover_path: string | null;
  file_path: string | null;
  status: BookStatus;
  created_at: string;
  updated_at: string;
};
