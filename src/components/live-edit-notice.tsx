import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import type { PendingChangeField } from "@/lib/book-pending-changes";
import {
  DISCARD_CHANGES_BUTTON,
  LIVE_EDIT_NOTE,
  LIVE_MANAGE_LINK,
  PENDING_CHANGES_LEAD,
  PENDING_CHANGES_SEND_LINK,
  PENDING_FIELD_LABELS,
  BOOK_ACTIONS_ID,
  editorPath,
} from "@/lib/book-editor-copy";

// BD15 P5b-2: the note on every tab of a live book's editor -- it stays
// on sale as it is, which changes wait for Librum's review, the changes
// waiting to be sent (with "Hidhni ndryshimet"), and (P5b-3a) a link down
// to the Veprime box under the tab, which takes it off sale or deletes it.
export function LiveEditNotice({
  bookId,
  changed,
  discardAction,
}: {
  bookId: string;
  changed: readonly PendingChangeField[];
  discardAction: () => void | Promise<void>;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3">
      <Alert variant="info">
        <p>{LIVE_EDIT_NOTE}</p>
        <p className="mt-1.5">
          <a
            href={`#${BOOK_ACTIONS_ID}`}
            className="font-medium text-primary underline underline-offset-2 hover:decoration-2"
          >
            {LIVE_MANAGE_LINK}
          </a>
        </p>
      </Alert>
      {changed.length > 0 && (
        <Alert variant="warning">
          <p className="font-semibold">
            {PENDING_CHANGES_LEAD} {changed.map((field) => PENDING_FIELD_LABELS[field]).join(", ")}.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              href={editorPath(bookId, "pricing")}
              className="font-medium text-primary underline underline-offset-2 hover:decoration-2"
            >
              {PENDING_CHANGES_SEND_LINK}
            </Link>
            <form action={discardAction}>
              <button
                type="submit"
                className="focus-ring inline-flex min-h-11 items-center text-sm font-medium text-red-700 underline underline-offset-2 hover:decoration-2"
              >
                {DISCARD_CHANGES_BUTTON}
              </button>
            </form>
          </div>
        </Alert>
      )}
    </div>
  );
}
