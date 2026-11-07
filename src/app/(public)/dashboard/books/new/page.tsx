import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { saveBookDetails } from "../editor-actions";
import { BookEditorShell } from "@/components/book-editor-shell";
import { BookDetailsForm, type DetailsFormValues } from "@/components/book-details-form";
import { pageErrorMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Libër i ri",
};

// BD15 P2: "+ Libër i ri" opens the new editor on its Details tab. The
// first "Ruaj draftin" or "Ruaj dhe vazhdo" creates the draft (a title
// is enough) and continues at /dashboard/books/<id>/editor.
//
// The old one-step wizard and createBook were removed in the BD15 cleanup.
export default async function NewBookPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error: rawError } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/dashboard/books/new");
  }

  const [{ data: penNames }, { data: series }] = await Promise.all([
    supabase
      .from("pen_names")
      .select("id, name, is_default")
      .eq("author_id", user.id)
      .order("created_at")
      .returns<{ id: string; name: string; is_default: boolean }[]>(),
    supabase
      .from("series")
      .select("id, title, pen_name_id")
      .eq("author_id", user.id)
      .order("title")
      .returns<{ id: string; title: string; pen_name_id: string | null }[]>(),
  ]);
  const penNameList = penNames ?? [];

  const initial: DetailsFormValues = {
    title: "",
    subtitle: "",
    language: "sq",
    seriesId: "",
    seriesPosition: "",
    editionNumber: "",
    // The default pen name is chosen; an author without any pen name row
    // yet gets the default one made on the first save.
    penNameId: penNameList.find((p) => p.is_default)?.id ?? penNameList[0]?.id ?? "",
    description: "",
    isAdult: false,
    readingAge: "",
    bookType: "",
    categories: [],
    keywords: "",
    contributors: [],
    rightsBasis: "",
    originalAuthor: "",
  };

  return (
    <BookEditorShell
      bookId={null}
      heading="Libër i ri"
      statusLabel="Draft i ri"
      tab="details"
      done={{ details: false, content: false, pricing: false }}
      error={pageErrorMessage(rawError)}
      success={null}
    >
      <BookDetailsForm
        action={saveBookDetails.bind(null, null)}
        initial={initial}
        locked={false}
        lockedPenName={null}
        penNames={penNameList}
        series={series ?? []}
      />
    </BookEditorShell>
  );
}
