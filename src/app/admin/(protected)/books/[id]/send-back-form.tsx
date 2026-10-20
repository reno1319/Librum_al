"use client";

import { useRef } from "react";
import {
  SEND_BACK_MESSAGE_MAX_LENGTH,
  SEND_BACK_PREFILL_MESSAGES,
  SEND_BACK_REASONS,
  TAKEDOWN_REASON_LABELS,
  type SendBackReason,
} from "@/lib/takedown-reasons";

// ADMIN-3-REVIEW (H, N7): the Send back form, inside a disclosure so it
// opens only when staff choose "Send back". A plain form posting to the
// server action, so it works without JavaScript (the message starts with
// the first reason's text). With JavaScript, choosing another reason
// swaps in that reason's text -- only while the staff member has not
// edited it, as the Unpublish form does. "Other" starts empty.

const CONTROL_CLASSES = "focus-ring rounded-control border border-control bg-surface px-3 py-2 text-base font-normal";
const DEFAULT_REASON: SendBackReason = "copyright";

export function SendBackForm({
  action,
  bookId,
  reviewId,
  defaultOpen = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  bookId: string;
  reviewId: string;
  defaultOpen?: boolean;
}) {
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const lastPrefill = useRef(SEND_BACK_PREFILL_MESSAGES[DEFAULT_REASON]);

  function onReasonChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const box = messageRef.current;
    const reason = event.target.value as SendBackReason;
    if (!box || !(reason in SEND_BACK_PREFILL_MESSAGES)) return;
    if (box.value.trim() === "" || box.value === lastPrefill.current) {
      box.value = SEND_BACK_PREFILL_MESSAGES[reason];
      lastPrefill.current = box.value;
    }
  }

  return (
    <details open={defaultOpen} className="group rounded-[3px] border border-border">
      <summary className="focus-ring flex min-h-11 cursor-pointer list-none items-center justify-center rounded-[3px] px-[1.125rem] text-[0.9375rem] font-semibold text-primary hover:bg-surface-hover group-open:border-b group-open:border-border">
        Send back
      </summary>
      <form action={action} className="flex flex-col gap-4 p-4">
        <input type="hidden" name="bookId" value={bookId} />
        <input type="hidden" name="reviewId" value={reviewId} />
        <label className="flex flex-col gap-1.5 text-[0.9375rem] font-semibold">
          Reason
          <select
            name="reason"
            defaultValue={DEFAULT_REASON}
            onChange={onReasonChange}
            className={`${CONTROL_CLASSES} min-h-11 w-full`}
          >
            {SEND_BACK_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {TAKEDOWN_REASON_LABELS[reason]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[0.9375rem] font-semibold">
          Message to the author
          <textarea
            ref={messageRef}
            name="message"
            rows={5}
            required
            maxLength={SEND_BACK_MESSAGE_MAX_LENGTH}
            defaultValue={SEND_BACK_PREFILL_MESSAGES[DEFAULT_REASON]}
            className={`${CONTROL_CLASSES} w-full`}
          />
        </label>
        <p className="text-sm text-muted">The book stays a draft. The author sees your message on their Dashboard.</p>
        <button
          type="submit"
          className="focus-ring inline-flex min-h-11 items-center justify-center self-start rounded-[3px] bg-[#8E2A1E] px-[1.125rem] text-[0.9375rem] font-semibold text-white transition-colors hover:bg-[#74221a]"
        >
          Send back to the author
        </button>
      </form>
    </details>
  );
}
