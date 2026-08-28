"use client";

import { useEffect } from "react";

// LIBRUM 2.0 LAUNCH-FIX-1A ERR-1: root/global-error.tsx are NOT
// redundant here -- confirmed by reading src/app/layout.tsx and
// src/components/site-header.tsx directly before adding this file.
// SiteHeader is rendered as a SIBLING of {children} inside RootLayout,
// not a descendant of it, and it does real per-request async work that
// can fail (createClient() + supabase.auth.getUser(), on every single
// route). A failure there throws from inside the root layout itself --
// outside the subtree src/app/error.tsx can catch, since a segment
// error boundary only wraps what's below it, never its own parent
// layout. Only global-error.tsx, which replaces the ENTIRE root layout
// including <html>/<body>, can catch that class of failure. This isn't
// added reflexively: it's the one gap root error.tsx structurally
// cannot cover in this app.
//
// Deliberately minimal and self-contained -- does NOT import
// SiteHeader/SiteFooter/globals.css/next/font (any of which could be
// implicated in why RootLayout itself failed), and supplies its own
// <html>/<body> shell as Next requires for this specific file. Inline
// styles only, so this still renders correctly even if the stylesheet
// itself failed to load.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error boundary caught:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          color: "#1a1a1a",
          background: "#faf9f6",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "28rem" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.75rem",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "#6b6b6b",
            }}
          >
            Error
          </p>
          <h1 style={{ marginTop: "0.5rem", fontSize: "1.75rem", fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: "0.75rem", color: "#6b6b6b" }}>
            We couldn&apos;t load Librum. Please try again.
          </p>
          <div
            style={{
              marginTop: "2rem",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <button
              type="button"
              onClick={() => reset()}
              style={{
                borderRadius: "0.375rem",
                border: "none",
                background: "#33518f",
                color: "#fff",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate: this file's entire premise is that the root layout (and everything Next's client-side router depends on) may itself have failed, so the recovery link stays a plain anchor rather than next/link. */}
            <a
              href="/"
              style={{ fontSize: "0.875rem", color: "#6b6b6b", textDecoration: "underline" }}
            >
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
