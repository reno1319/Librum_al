import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { EDITOR_CONTROL_CLASSES } from "@/components/book-editor-ui";
import {
  FINAL_FILE_MISS_RULE,
  PREORDER_PANEL_HEADING,
  PUSH_BUTTON,
  PUSH_HEADING,
  PUSH_NOTE,
  PUSH_TOO_LATE_NOTE,
  PUSH_USED_NOTE,
  RELEASE_DATE_FIELD,
  finalFileLine,
  preorderPushWindow,
  preorderReleaseLine,
  waitingReadersLine,
  type FinalFileState,
  type PushState,
} from "@/lib/preorders";

// BD16 P2 (PLAN-BD16-r1 §3.4, P2 row): a live pre-order's box at the top
// of every editor tab -- the release day, where the final manuscript
// stands (with its due date), how many readers wait (a count only), and
// the one push of the date (Q2 a). The cancel sits in the Veprime box.
// Every rule is checked again by push_preorder_release_date (LB504).
export function PreorderPanel({
  releaseDate,
  finalFile,
  waitingReaders,
  push,
  pushAction,
}: {
  releaseDate: string;
  finalFile: FinalFileState;
  /** null: unreadable, not shown. */
  waitingReaders: number | null;
  push: PushState;
  pushAction: (formData: FormData) => void | Promise<void>;
}) {
  const window = preorderPushWindow(releaseDate);
  return (
    <section
      id="parapublikimi"
      aria-labelledby="parapublikimi-heading"
      className="mt-4 rounded-card border border-border bg-surface p-4 shadow-sm"
    >
      <h2 id="parapublikimi-heading" className="font-serif text-lg font-normal">
        {PREORDER_PANEL_HEADING}
      </h2>
      <p className="mt-2 font-semibold">{preorderReleaseLine(releaseDate)}</p>
      <Alert variant={finalFile === "saved_not_sent" || finalFile === "missing" ? "warning" : "info"} className="mt-3">
        <p>{finalFileLine(finalFile, releaseDate)}</p>
        {(finalFile === "saved_not_sent" || finalFile === "missing") && <p className="mt-1.5">{FINAL_FILE_MISS_RULE}</p>}
      </Alert>
      {waitingReaders !== null && <p className="mt-3 text-sm text-muted">{waitingReadersLine(waitingReaders)}.</p>}

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">{PUSH_HEADING}</h3>
        {push === "used" ? (
          <p className="mt-1 text-sm text-muted">{PUSH_USED_NOTE}</p>
        ) : push === "too_late" ? (
          <p className="mt-1 text-sm text-muted">{PUSH_TOO_LATE_NOTE}</p>
        ) : (
          <form action={pushAction} className="mt-1 flex flex-col gap-2">
            <p className="text-sm text-muted">{PUSH_NOTE}</p>
            <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
              <span>Data e re e daljes</span>
              <input
                type="date"
                name={RELEASE_DATE_FIELD}
                required
                min={window.min}
                max={window.max}
                className={EDITOR_CONTROL_CLASSES}
              />
            </label>
            <div>
              <button type="submit" className={buttonClasses("outline", "md", "w-full sm:w-auto")}>
                {PUSH_BUTTON}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
