"use client";

import { useEffect, useState } from "react";
import { buttonClasses } from "@/components/ui/button";

// N2 rs2: after a send, the button waits 60 seconds -- Supabase's own
// per-address wait -- so a press is never silently ignored.
export const RESEND_WAIT_SECONDS = 60;

export function ResendSubmitButton({ justSent }: { justSent: boolean }) {
  const [left, setLeft] = useState(justSent ? RESEND_WAIT_SECONDS : 0);

  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  return (
    <button
      type="submit"
      disabled={left > 0}
      className={`mt-2 ${buttonClasses("primary", "md")}`}
    >
      {left > 0 ? `Dërgoni përsëri pas ${left} s` : "Dërgoni lidhjen"}
    </button>
  );
}
