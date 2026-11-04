import "server-only";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";

// BD15 P3: the author's "AI used" answer (PLAN-BD15-r1 §2.4). It lives
// in the staff-only table book_ai_disclosures (migration 20261103200000):
// no anon or authenticated grant at all, never in a public view. Only
// the trusted catalog writer reads or writes it, and only after the
// caller has proven the book is the signed-in author's own.

export type AiAnswer = "yes" | "no";

export type AiDisclosureRead = { ok: true; answer: AiAnswer | null } | { ok: false };

/** The form's value, or null when it is missing or anything else. */
export function parseAiAnswer(raw: FormDataEntryValue | null): AiAnswer | null {
  return raw === "yes" || raw === "no" ? raw : null;
}

/** The book's answer (null = not answered yet). Caller proved ownership. */
export async function readAiDisclosure(bookId: string): Promise<AiDisclosureRead> {
  try {
    const { data, error } = await createCatalogWriteClient()
      .from("book_ai_disclosures")
      .select("ai_used")
      .eq("book_id", bookId)
      .maybeSingle<{ ai_used: boolean }>();
    if (error) return { ok: false };
    if (!data) return { ok: true, answer: null };
    return { ok: true, answer: data.ai_used ? "yes" : "no" };
  } catch {
    return { ok: false };
  }
}

/** Records the answer (one row per book). Caller proved ownership. */
export async function writeAiDisclosure(bookId: string, answer: AiAnswer): Promise<boolean> {
  try {
    const { error } = await createCatalogWriteClient()
      .from("book_ai_disclosures")
      .upsert(
        { book_id: bookId, ai_used: answer === "yes", answered_at: new Date().toISOString() },
        { onConflict: "book_id" },
      );
    return !error;
  } catch {
    return false;
  }
}
