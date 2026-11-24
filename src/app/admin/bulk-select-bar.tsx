"use client";

import { useCallback, useSyncExternalStore } from "react";
import { BULK_PICK_FIELD } from "./bulk-select-logic";

// G4 batch 3 (approved pictures r1): the bar above the Reader reviews
// and Feedback lists. "Select all", "N selected" and the one action
// button, which acts at once (b3e2 a). The tick box on each card sits
// outside this form and joins it with form={formId}, so the cards stay
// server-rendered. The count is read from the page's own tick boxes.
const noopSubscribe = () => () => {};

export function BulkSelectBar({
  formId,
  action,
  actionLabel,
  hidden,
  className = "",
}: {
  formId: string;
  action: (formData: FormData) => void | Promise<void>;
  actionLabel: string;
  hidden?: Readonly<Record<string, string>>;
  className?: string;
}) {
  const boxes = useCallback(
    () =>
      Array.from(
        document.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][name="${BULK_PICK_FIELD}"][form="${formId}"]`,
        ),
      ),
    [formId],
  );

  // The tick boxes are the store: any change event re-reads them.
  const subscribe = useCallback((onStoreChange: () => void) => {
    document.addEventListener("change", onStoreChange);
    return () => document.removeEventListener("change", onStoreChange);
  }, []);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => {
      const all = boxes();
      return `${all.filter((box) => box.checked).length}/${all.length}`;
    },
    () => "0/0",
  );
  const [selected, total] = snapshot.split("/").map(Number);
  // False on the server and before hydration, so the button still works without JavaScript.
  const ready = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  function selectAll(checked: boolean) {
    for (const box of boxes()) {
      box.checked = checked;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  return (
    <form
      id={formId}
      action={action}
      className={`flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 ${className}`}
    >
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          checked={total > 0 && selected === total}
          onChange={(event) => selectAll(event.target.checked)}
          className="size-5 accent-[#1E3A32]"
        />
        Select all
      </label>
      <span className="text-sm text-muted" aria-live="polite">
        {selected} selected
      </span>
      <button
        type="submit"
        disabled={ready && selected === 0}
        className="focus-ring ml-auto min-h-11 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {actionLabel} ({selected})
      </button>
    </form>
  );
}
