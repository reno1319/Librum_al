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
  keywords: string;
  genre: string | null;
  series_id: string | null;
  series_position: number | null;
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

export type Series = {
  id: string;
  author_id: string;
  title: string;
  created_at: string;
};

export type Contributor = {
  id: string;
  book_id: string;
  name: string;
  role: string;
  created_at: string;
};

export type Bundle = {
  id: string;
  author_id: string;
  title: string;
  description: string;
  price_cents: number;
  status: BookStatus;
  created_at: string;
  updated_at: string;
};

export type DiscountCode = {
  id: string;
  author_id: string;
  book_id: string;
  code: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  active: boolean;
  expires_at: string | null;
  created_at: string;
};
