"use client";

export function DeleteBookButton({ title }: { title: string }) {
  return (
    <button
      type="submit"
      className="rounded-lg border border-border px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
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
