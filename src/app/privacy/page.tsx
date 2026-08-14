export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Privacy Policy</h1>

      <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
        This is placeholder text, not real legal advice. Have a lawyer
        review and adapt it before this platform handles real users or
        real payments.
      </p>

      <div className="mt-8 flex flex-col gap-6 text-foreground/90">
        <section>
          <h2 className="font-serif text-lg font-semibold">
            What we collect
          </h2>
          <p className="mt-2">
            Your name and email (from sign-up), the books you upload or
            purchase, and basic account activity. We don&apos;t collect or
            store payment card details — Stripe handles that directly.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            How we use it
          </h2>
          <p className="mt-2">
            To run your account, process purchases, deliver the books
            you&apos;ve bought, and pay authors for their sales.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            Who we share it with
          </h2>
          <p className="mt-2">
            Supabase (database, authentication, file storage) and Stripe
            (payments and payouts). We don&apos;t sell your data.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            Your rights
          </h2>
          <p className="mt-2">
            You can request a copy of your data or ask us to delete your
            account by contacting us.
          </p>
        </section>
      </div>
    </main>
  );
}
