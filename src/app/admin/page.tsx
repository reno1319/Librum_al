import { requireAdmin } from "@/lib/auth";

// Minimal admin landing page for Phase REFUND-1A -- proves
// requireAdmin() actually gates this route (unauthenticated -> /login,
// authenticated non-admin -> /, admin -> this page renders) before any
// real admin functionality (refund review, moderation, etc.) is built
// on top of it. Intentionally no content beyond that proof yet.
export default async function AdminPage() {
  const { profile } = await requireAdmin();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Admin</h1>
      <p className="mt-1 text-sm text-muted">Librum administration</p>
      <p className="mt-6 text-sm text-foreground/90">
        Signed in as {profile.display_name}.
      </p>
    </main>
  );
}
