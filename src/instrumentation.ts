import type { Instrumentation } from "next";

// ALERTS-1: every server error the site captures is passed to
// src/lib/error-alerts.ts, which emails the team (production only,
// capped). Node.js runtime only: the email client is not loaded on Edge.
// Awaited, as the instrumentation docs ask, so the send is not cut off.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportServerError } = await import("@/lib/error-alerts");
  await reportServerError(error, request, context);
};
