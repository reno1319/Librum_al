"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance, throwMaintenanceError } from "@/lib/maintenance-response";
import { FIXED_ALL_DISCOUNT_FORM_TYPE, parseFixedDiscountAll } from "@/lib/discount-amount";

export async function createDiscountCode(formData: FormData) {
  // ALL-CUTOVER APP-A: discount amount is written by this action --
  // gated before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard/discounts");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const bookId = String(formData.get("bookId") ?? "");
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const type = String(formData.get("type") ?? "");
  const rawValue = formData.get("value");
  const expiresAt = String(formData.get("expiresAt") ?? "").trim();

  if (!bookId || !code) {
    redirect("/dashboard/discounts?error=Please+fill+in+every+field");
  }

  const { data: book } = await supabase
    .from("books")
    .select("id")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle();

  if (!book) {
    redirect("/dashboard/discounts?error=Choose+one+of+your+own+books");
  }

  // ALL-DISCOUNT-3: exactly ONE discount column is named in the insert,
  // and it is never `amount_off_cents`. The legacy USD column is absent
  // from the payload altogether, not sent as null: PostgREST names every
  // key it receives in the INSERT's column list, and authenticated holds
  // no INSERT privilege on that column, so even a null would be refused.
  let discount: { percent_off: number } | { amount_off_all: number };
  if (type === "percent") {
    // Unchanged percentage parsing and bounds.
    const value = Number(rawValue ?? 0);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      redirect("/dashboard/discounts?error=Percent+off+must+be+between+1+and+100");
    }
    discount = { percent_off: value };
  } else if (type === FIXED_ALL_DISCOUNT_FORM_TYPE) {
    // Whole lek, 1..100000, parsed from the string without a float step.
    // No catalog minimum and no check against the book's current price:
    // whether a code leaves a legal price is decided, and rejected, at
    // checkout.
    const parsed = parseFixedDiscountAll(rawValue);
    if (!parsed.ok) {
      redirect("/dashboard/discounts?error=Fixed+amount+off+must+be+a+whole+number+of+lek+from+1+to+100000");
    }
    discount = { amount_off_all: parsed.amountOffAll };
  } else {
    redirect("/dashboard/discounts?error=Choose+a+discount+type");
  }

  const { error } = await supabase.from("discount_codes").insert({
    id: randomUUID(),
    author_id: user.id,
    book_id: bookId,
    code,
    ...discount,
    expires_at: expiresAt || null,
  });

  if (error) {
    const message = error.code === "23505"
      ? "That code already exists for this book"
      : error.message;
    redirect(`/dashboard/discounts?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/discounts");
  redirect("/dashboard/discounts?success=Discount+code+created");
}

export async function toggleDiscountCode(id: string, currentlyActive: boolean) {
  // ALL-CUTOVER APP-A: no existing business-error redirect convention
  // to mirror (mutate-and-revalidate only) -- throws instead.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    throwMaintenanceError();
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase
    .from("discount_codes")
    .update({ active: !currentlyActive })
    .eq("id", id)
    .eq("author_id", user.id);

  revalidatePath("/dashboard/discounts");
}

export async function deleteDiscountCode(id: string) {
  // ALL-CUTOVER APP-A: same reasoning as toggleDiscountCode() above.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    throwMaintenanceError();
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase
    .from("discount_codes")
    .delete()
    .eq("id", id)
    .eq("author_id", user.id);

  revalidatePath("/dashboard/discounts");
}
