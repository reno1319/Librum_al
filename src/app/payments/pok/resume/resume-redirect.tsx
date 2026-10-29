"use client";

import { useEffect } from "react";

// R3-ADDR: a full browser navigation, not a router push. location.replace()
// makes the browser itself request the return route, follow its redirect
// and show the final book address, and it drops this page's own entry
// (which carries the token) from the Back history.
export function ResumeRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col justify-center px-4">
      <p className="text-sm text-muted">Po e përfundojmë blerjen…</p>
      <p className="mt-2 text-sm">
        <a href={to} className="focus-ring rounded-sm font-medium text-primary underline">
          Vazhdoni
        </a>
      </p>
    </main>
  );
}
