import { SUSPEND_REASON_MAX_LENGTH, type AccessFix } from "../suspension-logic";

// PEOPLE-2 (1a, 2a): the Suspend / Lift panel on /admin/people/[id],
// rendered only for people.manage holders, never on a staff row or the
// viewer's own row (the RPC refuses those anyway). Plain forms posting
// to the server actions, so they work without JavaScript. Each opens in
// a disclosure first, so one stray click never suspends or lifts:
// Suspend asks for the reason, Lift asks for one more click. When the
// Supabase Auth ban disagrees with the suspension row, a "Try again"
// form retries only that step.

type Action = (formData: FormData) => void | Promise<void>;

const CONTROL_CLASSES = "focus-ring rounded-control border border-control bg-surface px-3 py-2 text-base font-normal";
const SUMMARY_CLASSES =
  "focus-ring flex min-h-11 cursor-pointer list-none items-center justify-center rounded-[3px] px-[1.125rem] text-[0.9375rem] font-semibold hover:bg-surface-hover group-open:border-b group-open:border-border";
const RED_BUTTON_CLASSES =
  "focus-ring inline-flex min-h-11 items-center justify-center self-start rounded-[3px] bg-[#8E2A1E] px-[1.125rem] text-[0.9375rem] font-semibold text-white transition-colors hover:bg-[#74221a]";
const PLAIN_BUTTON_CLASSES =
  "focus-ring inline-flex min-h-11 items-center justify-center self-start rounded-[3px] bg-primary px-[1.125rem] text-[0.9375rem] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover";

export function SuspensionPanel({
  userId,
  suspended,
  accessFix,
  suspendAction,
  liftAction,
  retryAction,
}: {
  userId: string;
  suspended: boolean;
  accessFix: AccessFix;
  suspendAction: Action;
  liftAction: Action;
  retryAction: Action;
}) {
  return (
    <section aria-labelledby="person-suspension" className="rounded-card border border-border bg-surface p-5">
      <h2 id="person-suspension" className="mb-2.5 font-serif text-[1.375rem] font-bold text-primary">
        {suspended ? "Suspended" : "Suspend"}
      </h2>

      {accessFix && (
        <form action={retryAction} className="mb-4 flex flex-col gap-3 rounded-[3px] border border-[#8E2A1E] p-4">
          <input type="hidden" name="userId" value={userId} />
          <p className="text-sm">
            {accessFix === "ban"
              ? "This account is suspended, but it can still sign in. Signed-in pages are still blocked."
              : "This account isn't suspended, but it still can't sign in."}
          </p>
          <button type="submit" className={PLAIN_BUTTON_CLASSES}>
            Try again
          </button>
        </form>
      )}

      {suspended ? (
        <>
          <p className="mb-3 text-sm text-muted">
            Lifting lets them sign in again and puts back the books and bundles the suspension took out, except any
            that need review or were taken down.
          </p>
          <details className="group rounded-[3px] border border-border">
            <summary className={`${SUMMARY_CLASSES} text-primary`}>Lift suspension</summary>
            <form action={liftAction} className="flex flex-col gap-3 p-4">
              <input type="hidden" name="userId" value={userId} />
              <p className="text-sm">They get an email saying their account is active again.</p>
              <button type="submit" className={PLAIN_BUTTON_CLASSES}>
                Yes, lift the suspension
              </button>
            </form>
          </details>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            Suspending signs them out and blocks sign-in, and takes their books, pen-name pages, series pages and
            reviews out of the Bookstore. Readers keep what they bought. Payouts are held.
          </p>
          <details className="group rounded-[3px] border border-border">
            <summary className={`${SUMMARY_CLASSES} text-[#8E2A1E]`}>Suspend account</summary>
            <form action={suspendAction} className="flex flex-col gap-4 p-4">
              <input type="hidden" name="userId" value={userId} />
              <label className="flex flex-col gap-1.5 text-[0.9375rem] font-semibold">
                Reason (staff only, never shown to them)
                <textarea
                  name="reason"
                  rows={4}
                  required
                  maxLength={SUSPEND_REASON_MAX_LENGTH}
                  className={`${CONTROL_CLASSES} w-full`}
                />
              </label>
              <p className="text-sm text-muted">They get an email saying their account is suspended. It doesn&apos;t include the reason.</p>
              <button type="submit" className={RED_BUTTON_CLASSES}>
                Suspend account
              </button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}
