import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { EDITOR_TABS, editorPath, type EditorTab } from "@/lib/book-editor-copy";

// BD15 P2: the new book editor's frame -- back link, heading, the three
// tabs with their done / not done state, and the page's one message.
// A server component; the tabs are plain links (each tab is its own
// page load, saved by its own form).
//
// D1 (mockup v5): a "Draft" pill beside "Libër elektronik", and the
// tabs as three boxes -- the open one white with a green line under it,
// the others light beige, each with ✓ or its number.

export function BookEditorShell({
  bookId,
  heading,
  statusLabel,
  tab,
  done,
  error,
  success,
  readOnly = false,
  children,
}: {
  bookId: string | null;
  heading: string;
  // The pill: "Draft", "Draft i ri", "Në shitje", "Në shqyrtim",
  // "Hequr nga Libraria".
  statusLabel: string;
  tab: EditorTab;
  done: Record<EditorTab, boolean>;
  error: string | null;
  success: string | null;
  // BD15 P5b-3a: a book in review shows what was sent, not the tabs.
  readOnly?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="page-container flex-1 pt-5 pb-16 sm:pt-8">
      <Link
        href="/dashboard/books"
        className="focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
      >
        &larr; Librat e mi
      </Link>
      <h1 className="mt-3 break-words font-serif text-[1.875rem] font-normal leading-tight text-primary sm:text-[2.5rem]">
        {heading}
      </h1>
      <p className="mt-1.5 flex items-center gap-2 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-hover px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.04em] text-foreground">
          <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-control" />
          {statusLabel}
        </span>
        <span>Libër elektronik</span>
      </p>

      {!readOnly && (
      <nav aria-label="Pjesët e librit" className="mt-5">
        <ol className="grid grid-cols-3 gap-1.5 sm:gap-3">
          {EDITOR_TABS.map((t, i) => {
            const current = t.key === tab;
            const isDone = done[t.key];
            const state = isDone ? "Plotësuar" : current ? "Në progres" : "Pa plotësuar";
            const body = (
              <>
                <span
                  aria-hidden="true"
                  className={`grid h-5 w-5 flex-none place-items-center rounded-full border-[1.5px] text-[11px] font-bold ${
                    isDone
                      ? "border-primary bg-primary text-primary-foreground"
                      : current
                        ? "border-primary bg-surface text-primary"
                        : "border-control bg-surface text-muted"
                  }`}
                >
                  {isDone ? "✓" : i + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={`text-sm font-bold sm:text-base ${current ? "text-foreground" : "text-primary"}`}>
                    {t.label}
                  </span>
                  <span className="text-xs text-muted max-sm:sr-only">{state}</span>
                </span>
              </>
            );
            const classes = `flex h-full min-w-0 flex-col items-start gap-1.5 rounded-t-lg border-b-[3px] p-2.5 sm:flex-row sm:items-center sm:gap-2.5 sm:px-5 sm:pt-3.5 sm:pb-3 ${
              current ? "border-primary bg-surface" : "border-transparent bg-surface-hover"
            }`;
            return (
              <li key={t.key}>
                {bookId && !current ? (
                  <Link href={editorPath(bookId, t.key)} className={`focus-ring ${classes} hover:bg-[#e7e0d1]`}>
                    {body}
                  </Link>
                ) : (
                  <div className={classes} aria-current={current ? "step" : undefined}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {!bookId && (
          <p className="mt-2 text-sm text-muted">Ruajeni draftin një herë, pastaj hapen edhe pjesët e tjera.</p>
        )}
      </nav>
      )}

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      {children}
    </main>
  );
}
