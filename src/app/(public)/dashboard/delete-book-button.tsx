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
          `Delete "${title}"? This can't be undone. Books that have been acquired by readers can't be deleted — you'll need to unpublish this one instead if that's the case.`,
        );
        if (!confirmed) {
          e.preventDefault();
        }
      }}
    >
      Delete
    </button>
  );
}
