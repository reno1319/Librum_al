import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { deleteAccount } from "./actions";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, role")
    .eq("id", user.id)
    .single();

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Account</h1>
      <p className="mt-1 text-sm text-muted">
        Signed in as {user.email}
        {profile?.role ? ` (${profile.role})` : ""}
      </p>

      <section className="mt-10 rounded-lg border border-red-200 bg-red-50 p-6">
        <h2 className="font-serif text-lg font-semibold text-red-800">
          Delete account
        </h2>
        <p className="mt-2 text-sm text-red-800">
          This permanently deletes your account
          {profile?.role === "author"
            ? ", every book you've published, and their files"
            : " and removes your access to your library"}
          . This can&apos;t be undone.
          {profile?.role !== "author" && (
            <>
              {" "}
              Some transaction records may be retained, detached from
              your account, where necessary for payment accounting,
              refunds, disputes, or legal obligations.
            </>
          )}
        </p>

        {error && (
          <p className="mt-3 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}

        <form action={deleteAccount} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-red-900">
            Type DELETE to confirm
            <input
              name="confirmation"
              type="text"
              required
              className="rounded-lg border border-red-300 bg-white px-3 py-2"
            />
          </label>
          <button
            type="submit"
            className="w-fit rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
          >
            Permanently delete my account
          </button>
        </form>
      </section>
    </main>
  );
}
