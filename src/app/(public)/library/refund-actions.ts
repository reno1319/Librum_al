"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  mapRefundRpcError,
  validateRefundReason,
  GENERIC_REFUND_ERROR_MESSAGE,
  RPC_NOT_AUTHENTICATED_MESSAGE,
} from "./refund-logic";

// stripePaymentIntentId is bound server-side (see the .bind(null, ...)
// call sites in account/purchases/page.tsx) from the reader's own
// purchases rows fetched in that Server Component -- it is never a raw
// form field a reader
// could type into. request_refund() (migration 029) re-verifies
// ownership itself regardless (it only ever matches purchases rows
// where reader_id = auth.uid()), so even a tampered value can't be used
// to request a refund against another reader's transaction; it would
// simply fail that authoritative check.
export async function requestTransactionRefund(
  stripePaymentIntentId: string,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/purchases");
  }

  if (!stripePaymentIntentId) {
    redirect(`/account/purchases?error=${encodeURIComponent(GENERIC_REFUND_ERROR_MESSAGE)}`);
  }

  const reasonValidation = validateRefundReason(formData.get("reason"));
  if (!reasonValidation.ok) {
    redirect(`/account/purchases?error=${encodeURIComponent(reasonValidation.error)}`);
  }

  // request_refund() is the sole authority here: it re-derives
  // reader_id from auth.uid(), re-verifies ownership, re-checks the
  // 14-day window, the already-refunded state, and any existing open
  // request, and computes the refundable amount itself -- nothing
  // computed client-side (or in this action) is trusted for any of
  // that. See migration 029.
  const { error } = await supabase.rpc("request_refund", {
    p_stripe_payment_intent_id: stripePaymentIntentId,
    p_reason: reasonValidation.value,
  });

  if (error) {
    if (error.message === RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect("/login?next=/account/purchases");
    }
    redirect(`/account/purchases?error=${encodeURIComponent(mapRefundRpcError(error))}`);
  }

  revalidatePath("/account/purchases");
  redirect(
    `/account/purchases?success=${encodeURIComponent("Your refund request has been submitted for review.")}`,
  );
}

// refundRequestId is likewise bound server-side from a refund_requests
// row already scoped to this reader by the Server Component's own
// query (which itself relies on RLS -- see refund-requests select
// policy "Readers can view their own refund requests"). cancel_refund_
// request() (migration 029) still independently re-checks
// reader_id = auth.uid() and status = 'requested' before doing
// anything, so this is defense in depth, not the only thing stopping a
// reader from cancelling someone else's request.
export async function cancelRefundRequest(refundRequestId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/purchases");
  }

  const { error } = await supabase.rpc("cancel_refund_request", {
    p_id: refundRequestId,
  });

  if (error) {
    if (error.message === RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect("/login?next=/account/purchases");
    }
    redirect(`/account/purchases?error=${encodeURIComponent(mapRefundRpcError(error))}`);
  }

  revalidatePath("/account/purchases");
  redirect(
    `/account/purchases?success=${encodeURIComponent("Your refund request has been cancelled.")}`,
  );
}
