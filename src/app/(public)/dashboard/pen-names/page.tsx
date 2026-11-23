import { redirect } from "next/navigation";

// AUTHOR PROFILI (build 1): pen names are managed on Profili now. Old
// links (emails already sent, bookmarks) land there.
export default function PenNamesPage() {
  redirect("/dashboard/profile");
}
