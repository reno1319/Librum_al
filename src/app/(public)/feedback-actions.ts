"use server";

import { createClient } from "@/lib/supabase/server";
import { checkFeedbackInput, feedbackErrorMessage, FEEDBACK_ERRORS } from "@/lib/reader-feedback";

// K4 feedback button (Renato 2026-11-15): the corner button's "Dërgo".
// The signed-in reader's own session calls submit_reader_feedback(),
// which re-checks everything (the account, the kind, the text, the page,
// the hourly limit); this only checks first so a plain mistake gets its
// words without a round trip.

export type SendFeedbackResult = { ok: true } | { ok: false; error: string };

export async function sendFeedback(kind: unknown, body: unknown, pagePath: unknown): Promise<SendFeedbackResult> {
  const input = checkFeedbackInput(kind, body, pagePath);
  if (!input.ok) return input;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: FEEDBACK_ERRORS.signedOut };

  const { error } = await supabase.rpc("submit_reader_feedback", {
    p_kind: input.kind,
    p_body: input.body,
    p_page_path: input.pagePath,
  });
  if (error) {
    console.error("Feedback: the send failed", { code: error.code ?? null });
    return { ok: false, error: feedbackErrorMessage(error.code) };
  }
  return { ok: true };
}
