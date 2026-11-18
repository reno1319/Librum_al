"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { shareHrefs } from "@/lib/contact";

// SOCIAL (Renato soc2, 2026-11-18): the share row on book pages and blog
// posts -- logos only: WhatsApp, Facebook, X, LinkedIn, Copy link, and
// on phones the phone's own share menu (the only way to reach Instagram,
// Viber or Messenger). Each logo is a plain link to that site's share
// page; nothing from those sites loads on Librum.
//
// Without JavaScript, Copy link is a plain link to the page itself and
// the phone menu button is not shown.
//
// The four brand logos are the Simple Icons paths (CC0-1.0,
// simple-icons 9.21.0), copied here as data; no package was added.

const BRAND_PATHS = {
  whatsapp:
    "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z",
  facebook:
    "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z",
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  linkedin:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
};

const BUTTON_CLASSES =
  "focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/10 pointer-coarse:size-11";

function BrandIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-[1.125rem]">
      <path d={path} />
    </svg>
  );
}

function LineIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[1.1875rem]"
    >
      {children}
    </svg>
  );
}

function noSubscribe(): () => void {
  return () => {};
}

function phoneMenuAvailable(): boolean {
  return typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches;
}

export function ShareButtons({
  url,
  text,
  className,
}: {
  url: string;
  text: string;
  className?: string;
}) {
  const hrefs = shareHrefs({ url, text });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  // Phones and tablets only: computers with a share menu (Safari on a
  // Mac, Chrome on Windows) already have every option in the row. The
  // server (and the first paint) never shows it.
  const canUsePhoneMenu = useSyncExternalStore(noSubscribe, phoneMenuAvailable, () => false);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const networks = [
    { key: "whatsapp", label: "Ndajeni në WhatsApp", href: hrefs.whatsapp },
    { key: "facebook", label: "Ndajeni në Facebook", href: hrefs.facebook },
    { key: "x", label: "Ndajeni në X", href: hrefs.x },
    { key: "linkedin", label: "Ndajeni në LinkedIn", href: hrefs.linkedin },
  ] as const;

  return (
    <div className={className}>
      <p className="text-muted">Ndajeni:</p>
      <div className="-ml-2 flex flex-wrap items-center pointer-coarse:-ml-3">
        {networks.map((network) => (
          <a
            key={network.key}
            href={network.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={network.label}
            title={network.label}
            className={BUTTON_CLASSES}
          >
            <BrandIcon path={BRAND_PATHS[network.key]} />
          </a>
        ))}
        <a
          href={url}
          aria-label="Kopjo lidhjen"
          title="Kopjo lidhjen"
          className={BUTTON_CLASSES}
          onClick={(event) => {
            event.preventDefault();
            if (!navigator.clipboard?.writeText) {
              setCopyState("failed");
              return;
            }
            navigator.clipboard.writeText(url).then(
              () => setCopyState("copied"),
              () => setCopyState("failed"),
            );
          }}
        >
          {copyState === "copied" ? (
            <LineIcon>
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </LineIcon>
          ) : (
            <LineIcon>
              <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
              <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            </LineIcon>
          )}
        </a>
        {canUsePhoneMenu && (
          <button
            type="button"
            aria-label="Më shumë mënyra për ta ndarë"
            title="Më shumë mënyra për ta ndarë"
            className={BUTTON_CLASSES}
            onClick={() => {
              // Closing the menu without choosing rejects; nothing to do.
              navigator.share({ title: text, text, url }).catch(() => {});
            }}
          >
            <LineIcon>
              <path d="M12 15V3" />
              <path d="m7.5 7.5 4.5-4.5 4.5 4.5" />
              <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
            </LineIcon>
          </button>
        )}
      </div>
      <p aria-live="polite" className={copyState === "failed" ? "text-muted" : "sr-only"}>
        {copyState === "copied" ? "U kopjua" : copyState === "failed" ? "Kopjojeni nga shiriti i adresës" : ""}
      </p>
    </div>
  );
}
