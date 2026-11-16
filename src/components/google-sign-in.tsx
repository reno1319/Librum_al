import Link from "next/link";
import { signInWithGoogle, signUpWithGoogle } from "@/app/(public)/auth/actions";
import { buttonClasses } from "@/components/ui/button";

// K7 (Renato 11-16): "Vazhdo me Google" under the usual form, with one
// line under it and nothing else. On /signup the button submits the
// sign-up form itself (`form`), so the page's "Regjistrohem si..." choice
// and 18+ tick go with it; `formNoValidate` lets it go without the
// name/email/password the form otherwise needs. On /login it has its own
// small form, carrying a safe `next`.
export function GoogleSignIn({
  from,
  signupFormId,
  next,
}: {
  from: "login" | "signup";
  signupFormId?: string;
  next?: string;
}) {
  const button = (
    <button
      type="submit"
      form={from === "signup" ? signupFormId : undefined}
      formAction={from === "signup" ? signUpWithGoogle : undefined}
      formNoValidate={from === "signup" ? true : undefined}
      className={`mt-4 w-full gap-2 ${buttonClasses("outline", "md")} bg-surface`}
    >
      <GoogleMark />
      Vazhdo me Google
    </button>
  );
  return (
    <div className="mt-6 flex flex-col">
      <div className="flex items-center gap-3 text-sm text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        ose
        <span className="h-px flex-1 bg-border" />
      </div>
      {from === "signup" ? (
        button
      ) : (
        <form action={signInWithGoogle}>
          {next && <input type="hidden" name="next" value={next} />}
          {button}
        </form>
      )}
      <p className="mt-2 text-sm text-muted">
        Duke vazhduar me Google, pranoni{" "}
        <Link href="/kushtet" className="focus-ring rounded-sm font-medium text-primary underline">
          Kushtet e përdorimit
        </Link>{" "}
        dhe konfirmoni se keni lexuar{" "}
        <Link href="/privatesia" className="focus-ring rounded-sm font-medium text-primary underline">
          Politikën e privatësisë
        </Link>
        .
      </p>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
