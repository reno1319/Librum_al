export default function ContactPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Contact</h1>

      <p className="mt-6 text-foreground/90">
        Questions, problems, or feedback — reach out and we&apos;ll get
        back to you.
      </p>

      <p className="mt-4">
        <a
          href="mailto:support@librum.example"
          className="text-lg font-medium text-primary underline"
        >
          support@librum.example
        </a>
      </p>

      <p className="mt-6 text-sm text-muted">
        (Placeholder address — replace with a real inbox before this
        platform handles real users.)
      </p>
    </main>
  );
}
