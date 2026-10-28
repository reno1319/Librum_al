"use client";

// PHONE PASS (D3): `className` lets the Dashboard row's ··· menu show
// it as a menu item; the Edit page's Danger zone keeps the default look.
const DEFAULT_CLASS_NAME = "focus-ring rounded-control border border-border px-3 py-1.5 text-sm text-red-600 hover:bg-red-50";

export function DeleteBookButton({ title, className = DEFAULT_CLASS_NAME }: { title: string; className?: string }) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        const confirmed = window.confirm(
          `Ta fshini "${title}"? Ky veprim nuk mund të zhbëhet. Librat që lexuesit i kanë marrë nuk mund të fshihen: në atë rast hiqeni librin nga publikimi.`,
        );
        if (!confirmed) {
          e.preventDefault();
        }
      }}
    >
      Fshini
    </button>
  );
}
