"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { sendFeedback } from "@/app/(public)/feedback-actions";
import { FEEDBACK_BODY_MAX, FEEDBACK_KIND_LABEL, FEEDBACK_KINDS, type FeedbackKind } from "@/lib/reader-feedback";

// K4 feedback button (Renato 2026-11-15, feedback b a): a round button in
// the bottom-right corner of every public page, for signed-in people
// only (SiteHeader renders it). Tap it, tap "Problem" or "Ide", type,
// "Dërgo". The page path goes with the message. The book reader is a
// modal <dialog>, so it sits above this button; the admin has no
// SiteHeader. On phones it moves above the buy bar while that shows
// (globals.css).
type Kind = FeedbackKind;

export function FeedbackButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (kind) boxRef.current?.focus();
  }, [kind]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => {
    setOpen(false);
    setError(null);
    if (sent) {
      setSent(false);
      setKind(null);
      setText("");
    }
  };

  return (
    <div data-feedback-fab="" className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-end gap-3 md:right-6 md:bottom-6">
      {open && (
        <div
          role="dialog"
          aria-labelledby="feedback-title"
          className="w-[min(22rem,calc(100vw-2rem))] rounded-card border border-border bg-surface p-4 text-foreground shadow-[0_10px_30px_rgba(28,36,32,0.18)]"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id="feedback-title" className="font-serif text-lg font-bold text-primary">
              {sent ? "Faleminderit!" : "Na tregoni"}
            </h2>
            <button type="button" onClick={close} aria-label="Mbyll" className="focus-ring -mt-1 -mr-1 inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-hover">
              <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>
          </div>
          {sent ? (
            <p className="mt-2 text-[0.9375rem] text-foreground">
              E morëm mesazhin tuaj. Nëse duhet, do t’ju shkruajmë në emailin e llogarisë.
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!kind || !text.trim() || pending) return;
                setError(null);
                startTransition(async () => {
                  try {
                    const result = await sendFeedback(kind, text, pathname);
                    if (result.ok) setSent(true);
                    else setError(result.error);
                  } catch {
                    setError("Mesazhi nuk u dërgua. Provoni përsëri.");
                  }
                });
              }}
            >
              <p className="mt-1 text-sm text-muted">Diçka nuk funksionon, apo keni një ide?</p>
              <div role="radiogroup" aria-label="Lloji" className="mt-3 grid grid-cols-2 gap-2">
                {FEEDBACK_KINDS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={kind === value}
                    onClick={() => setKind(value)}
                    className={`focus-ring min-h-11 rounded-control border text-[0.9375rem] font-semibold transition-colors ${
                      kind === value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-control bg-surface text-foreground hover:bg-surface-hover"
                    }`}
                  >
                    {FEEDBACK_KIND_LABEL[value]}
                  </button>
                ))}
              </div>
              {kind && (
                <>
                  <label htmlFor="feedback-text" className="sr-only">Mesazhi</label>
                  <textarea
                    id="feedback-text"
                    ref={boxRef}
                    value={text}
                    maxLength={FEEDBACK_BODY_MAX}
                    rows={4}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={kind === "problem" ? "Çfarë nuk funksionoi?" : "Çfarë do të donit të shihnit?"}
                    className="focus-ring mt-3 block w-full resize-none rounded-control border border-control bg-surface px-3 py-2 text-base placeholder:text-placeholder"
                  />
                  <p className="mt-1.5 text-xs text-muted">
                    Bashkë me mesazhin dërgojmë faqen ku jeni ({pathname}).
                  </p>
                  {error && (
                    <p role="alert" className="mt-2 text-sm text-[#8E2A1E]">
                      {error}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={!text.trim() || pending}
                    className="focus-ring mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-primary px-4 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
                  >
                    {pending ? "Po dërgohet…" : "Dërgo"}
                  </button>
                </>
              )}
            </form>
          )}
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label="Na tregoni: problem ose ide"
        onClick={() => (open ? close() : setOpen(true))}
        className="focus-ring inline-flex size-12 items-center justify-center rounded-full border-2 border-primary-foreground bg-primary text-primary-foreground shadow-[0_6px_18px_rgba(28,36,32,0.25)] transition-colors hover:bg-primary-hover"
      >
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
          <path d="M8.5 9h7M8.5 12h4.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
