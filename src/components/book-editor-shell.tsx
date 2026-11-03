import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { EDITOR_TABS, editorPath, type EditorTab } from "@/lib/book-editor-copy";

// BD15 P2: the new book editor's frame -- back link, heading, the three
// tabs with their done / not done state, and the page's one message.
// A server component; the tabs are plain links (each tab is its own
// page load, saved by its own form).

export function BookEditorShell({
  bookId,
  heading,
  statusLine,
  tab,
  done,
  error,
  success,
  children,
}: {
  bookId: string | null;
  heading: string;
  statusLine: string;
  tab: EditorTab;
  done: Record<EditorTab, boolean>;
  error: string | null;
  success: string | null;
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
      <h1 className="mt-4 break-words font-serif text-[1.875rem] font-normal leading-tight text-primary sm:text-[2.5rem]">
        {heading}
      </h1>
      <p className="mt-1 text-sm text-muted">{statusLine}</p>

      <nav aria-label="Pjesët e librit" className="mt-6">
        <ol className="grid grid-cols-3 gap-2 sm:gap-3">
          {EDITOR_TABS.map((t, i) => {
            const current = t.key === tab;
            const state = done[t.key] ? "Plotësuar" : current ? "Në progres" : "Pa plotësuar";
            const body = (
              <>
                <span className="text-xs text-muted">{i + 1}</span>
                <span className={`text-sm ${current ? "font-bold text-primary" : "text-foreground"}`}>{t.label}</span>
                <span className={`text-xs ${done[t.key] ? "text-primary" : "text-muted"}`}>
                  {done[t.key] ? "✓ " : ""}
                  {state}
                </span>
              </>
            );
            const classes = `flex flex-col gap-0.5 rounded-[4px] border px-3 py-2 ${
              current ? "border-primary bg-surface" : "border-border"
            }`;
            return (
              <li key={t.key}>
                {bookId && !current ? (
                  <Link href={editorPath(bookId, t.key)} className={`focus-ring ${classes} hover:bg-surface-hover`}>
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
