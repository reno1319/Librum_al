"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createDiscountCode(formData: FormData) {
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
  const value = Number(formData.get("value") ?? 0);
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

  if (type === "percent") {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      redirect("/dashboard/discounts?error=Percent+off+must+be+between+1+and+100");
    }
  } else if (type === "amount") {
    if (!Number.isFinite(value) || value <= 0) {
      redirect("/dashboard/discounts?error=Amount+off+must+be+greater+than+0");
    }
  } else {
    redirect("/dashboard/discounts?error=Choose+a+discount+type");
  }

  const { error } = await supabase.from("discount_codes").insert({
    id: randomUUID(),
    author_id: user.id,
    book_id: bookId,
    code,
    percent_off: type === "percent" ? value : null,
    amount_off_cents: type === "amount" ? Math.round(value * 100) : null,
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
