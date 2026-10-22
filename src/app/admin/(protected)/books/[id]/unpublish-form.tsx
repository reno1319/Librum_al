"use client";

import { useRef } from "react";
import Link from "next/link";
import {
  TAKEDOWN_MESSAGE_MAX_LENGTH,
  TAKEDOWN_PREFILL_MESSAGES,
  TAKEDOWN_REASONS,
  TAKEDOWN_REASON_LABELS,
  type TakedownReason,
} from "@/lib/takedown-reasons";

// ADMIN-2-TAKEDOWN (C, S7): the Unpublish form. A plain form posting to
// the server action, so it works without JavaScript (the message starts
// with the preselected reason's text). With JavaScript, choosing another
// reason swaps in that reason's text -- but only while the staff member
// has not edited the message, so nothing they wrote is ever replaced.

// The shared control look (form-styles.ts) at 16px, so a phone does not
// zoom into the field.
const CONTROL_CLASSES = "focus-ring rounded-control border border-control bg-surface px-3 py-2 text-base font-normal";

export function UnpublishForm({
  action,
  bookId,
  reportId,
  defaultReason,
}: {
  action: (formData: FormData) => void | Promise<void>;
  bookId: string;
  reportId: string | null;
  defaultReason: TakedownReason;
}) {
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const lastPrefill = useRef(TAKEDOWN_PREFILL_MESSAGES[defaultReason]);

  function onReasonChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const box = messageRef.current;
    const reason = event.target.value as TakedownReason;
    if (!box || !(reason in TAKEDOWN_PREFILL_MESSAGES)) return;
    if (box.value.trim() === "" || box.value === lastPrefill.current) {
      box.value = TAKEDOWN_PREFILL_MESSAGES[reason];
      lastPrefill.current = box.value;
    }
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="bookId" value={bookId} />
      {reportId && <input type="hidden" name="reportId" value={reportId} />}
      <label className="flex flex-col gap-1.5 text-[0.9375rem] font-semibold">
        Reason
        <select
          name="reason"
          defaultValue={defaultReason}
          onChange={onReasonChange}
          className={`${CONTROL_CLASSES} min-h-11 w-full`}
        >
          {TAKEDOWN_REASONS.map((reason) => (
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
          maxLength={TAKEDOWN_MESSAGE_MAX_LENGTH}
          defaultValue={TAKEDOWN_PREFILL_MESSAGES[defaultReason]}
          className={`${CONTROL_CLASSES} w-full`}
        />
      </label>
      {reportId && <p className="text-sm text-foreground">This also resolves the report.</p>}
      <div className="flex flex-wrap gap-2.5">
        <button
          type="submit"
          className="focus-ring inline-flex min-h-11 items-center justify-center rounded-[3px] bg-[#8E2A1E] px-[1.125rem] text-[0.9375rem] font-semibold text-white transition-colors hover:bg-[#74221a]"
        >
          Unpublish now
        </button>
        <Link
          href={reportId ? `/admin/reports/${reportId}` : "/admin/books"}
          className="focus-ring inline-flex min-h-11 items-center justify-center rounded-[3px] border border-primary bg-surface px-[1.125rem] text-[0.9375rem] font-semibold text-primary hover:bg-surface-hover"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
