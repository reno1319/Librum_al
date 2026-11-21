import Link from "next/link";
import { resendConfirmationEmail } from "@/app/(public)/auth/actions";
import { translateAuthErrorMessage } from "@/lib/auth-error";
import { Alert } from "@/components/ui/alert";
import { ResendSubmitButton } from "@/components/resend-submit-button";
import { formControlClasses } from "@/lib/form-styles";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dërgoni përsëri emailin e konfirmimit",
  description: "Kërkoni një lidhje të re për të konfirmuar llogarinë tuaj në Librum.",
};

// N2: one page for a lost confirmation email, linked from «Shikoni
// emailin» and from sign-in (rs3 a). The address is typed here, never
// carried in the web address.
export default async function ResendConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
  const sent = Boolean(success);

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="font-serif text-3xl font-normal">Dërgoni përsëri emailin e konfirmimit</h1>

      {error && (
        <Alert variant="error" className="mt-4">
          {translateAuthErrorMessage(error)}
        </Alert>
      )}

      {sent ? (
        <Alert variant="success" className="mt-4">
          Nëse ky email ka një llogari që ende nuk është konfirmuar, ju dërguam një lidhje të
          re. Shikoni edhe dosjen Spam.
        </Alert>
      ) : (
        <p className="mt-1 text-sm text-muted">
          Shkruani emailin me të cilin u regjistruat dhe do t&apos;ju dërgojmë një lidhje të re
          konfirmimi.
        </p>
      )}

      <form action={resendConfirmationEmail} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Adresa e emailit
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className={formControlClasses}
          />
        </label>

        <ResendSubmitButton justSent={sent} />
      </form>

      <p className="mt-6 text-sm text-muted">
        <Link href="/login" className="focus-ring rounded-sm font-medium text-primary underline">
          Kthehuni te hyrja
        </Link>
      </p>
    </main>
  );
}
