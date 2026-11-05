import { redirect } from "next/navigation";

// BD15 P6 (Renato 11-05, Q1 a): the author's one bookshelf is the
// Dashboard (/dashboard). This old "all books" page duplicated its list,
// so it now only sends the author there; old links and the editor's
// "back" link keep working. The Dashboard does its own auth and
// maintenance checks.
export default function AllBooksPage(): never {
  redirect("/dashboard");
}
