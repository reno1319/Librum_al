"use client";

import { useFormStatus } from "react-dom";

// Client-side duplicate-submit mitigation only: disables the button
// while THIS rendered form's own submission is pending, so an ordinary
// second click on the same button is a no-op. It has no effect across
// separate browser tabs, a second independent page load, or a direct
// request to the server action -- each of those still calls buyBundle
// again, which still creates its own new snapshot and its own Stripe
// Checkout Session (buyBundle's idempotency key only protects a retry
// of the SAME snapshot's request, not two different snapshots). This
// does not provide server-side exactly-once checkout creation.
export function BuyBundleButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
    >
      {pending ? "Starting checkout…" : "Buy bundle"}
    </button>
  );
}
