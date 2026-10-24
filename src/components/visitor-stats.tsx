"use client";

import { Analytics } from "@vercel/analytics/next";
import { prepareVisitEvent } from "@/lib/visitor-stats";

// VISITOR STATS (pipeline item 6): a client wrapper only because the
// beforeSend function can't be passed down from a Server Component.
// Whether this renders at all is decided in src/app/(public)/layout.tsx.
export function VisitorStats() {
  return <Analytics beforeSend={prepareVisitEvent} />;
}
