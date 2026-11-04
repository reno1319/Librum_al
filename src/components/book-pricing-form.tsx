"use client";

import { useState } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { groupAllDigits } from "@/lib/catalog-price";
import { editorPath, EDITOR_TABS, type EditorTab } from "@/lib/book-editor-copy";
import {
  ACCEPT_TERMS_FIELD,
  ACCEPT_TERMS_LINK_TEXT,
  ACCEPT_TERMS_TEXT_BEFORE_LINK,
  BUYING_OPENS_SOON_LINE,
  FREE_BOOK_LINE,
  PAID_PUBLISHING_CLOSED_LINE,
  PREVIEW_EMPTY_LINE,
  PREVIEW_TOO_LOW_LINE,
  PRICE_FIELD,
  PRICE_FREE_LABEL,
  PRICE_HINT,
  PRICE_INPUT_LABEL,
  PRICE_MODE_FIELD,
  PRICE_PAID_LABEL,
  PRICING_WHERE_HEADING,
  PRICING_WHERE_LINE,
  PUBLIC_DOMAIN_FREE_ONLY_NOTE,
  PUBLISH_APPROVED_BUTTON,
  PUBLISH_APPROVED_NOTE,
  ROYALTY_RATES_LINE,
  ROYALTY_TAX_LINE,
  SEND_FOR_REVIEW_BUTTON,
  TERMS_PAGE_PATH,
  WORLDWIDE_RIGHTS_FIELD,
  WORLDWIDE_RIGHTS_TEXT,
  formatShareMinor,
  royaltyPreview,
  type PriceMode,
} from "@/lib/book-pricing";

// BD15 P4: the new editor's Pricing tab (PLAN-BD15-r1 §2.5; mockup
// "Çmimi"). A client form only for the live royalty preview; every rule
// is decided again by saveBookPricing on the server.
//
// The two ticks are never pre-ticked (Renato 11-04, Q2 a): each send
// asks for them again and records them.

const SECTION_CLASSES = "flex flex-col gap-3 rounded-[4px] border border-border bg-surface p-5 sm:p-6";
const CHOICE_CLASSES =
  "flex cursor-pointer items-center gap-3 rounded-[4px] border border-[#c9c0ae] bg-surface px-4 py-3 has-checked:border-2 has-checked:border-primary has-checked:bg-[#f4f8f5]";
const TICK_CLASSES = "flex cursor-pointer items-start gap-3 text-sm";

export type PricingMissing = { tab: EditorTab; label: string };

export function BookPricingForm({
  action,
  bookId,
  initialPriceAll,
  freeOnly,
  paidPublishingAvailable,
  checkoutAvailable,
  approvalValid,
  title,
  penName,
  missing,
}: {
  action: (formData: FormData) => void | Promise<void>;
  bookId: string;
  initialPriceAll: number | null;
  // Public-domain book: "Falas" only.
  freeOnly: boolean;
  paidPublishingAvailable: boolean;
  checkoutAvailable: boolean;
  // Librum's approval still matches the files: the button publishes.
  approvalValid: boolean;
  title: string;
  penName: string;
  // What the other tabs still need before sending.
  missing: PricingMissing[];
}) {
  const [mode, setMode] = useState<PriceMode | null>(
    freeOnly ? "free" : initialPriceAll === null ? null : initialPriceAll === 0 ? "free" : "paid",
  );
  const [price, setPrice] = useState(initialPriceAll && initialPriceAll > 0 ? String(initialPriceAll) : "");
  const preview = royaltyPreview(mode, price);
  const readerPrice =
    mode === "free" ? PRICE_FREE_LABEL : preview.kind === "paid" ? `${groupAllDigits(preview.priceAll)} lekë` : "—";

  return (
    <form action={action} className="mt-8 flex flex-col gap-6">
      <section className={SECTION_CLASSES} aria-labelledby="pricing-where">
        <h2 id="pricing-where" className="font-serif text-xl font-normal">
          {PRICING_WHERE_HEADING}
        </h2>
        <p className="text-sm text-muted">{PRICING_WHERE_LINE}</p>
        <label className={TICK_CLASSES}>
          <input
            type="checkbox"
            name={WORLDWIDE_RIGHTS_FIELD}
            className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-primary"
          />
          <span>{WORLDWIDE_RIGHTS_TEXT}.</span>
        </label>
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="pricing-price">
        <h2 id="pricing-price" className="font-serif text-xl font-normal">
          Çmimi
        </h2>
        {freeOnly ? (
          <>
            <input type="hidden" name={PRICE_MODE_FIELD} value="free" />
            <p className="font-medium">{PRICE_FREE_LABEL}</p>
            <p className="text-sm text-muted">{PUBLIC_DOMAIN_FREE_ONLY_NOTE}</p>
          </>
        ) : (
          <>
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Çmimi</legend>
              <label className={CHOICE_CLASSES}>
                <input
                  type="radio"
                  name={PRICE_MODE_FIELD}
                  value="paid"
                  checked={mode === "paid"}
                  onChange={() => setMode("paid")}
                  className="focus-ring h-5 w-5 shrink-0 accent-primary"
                />
                <span>{PRICE_PAID_LABEL}</span>
              </label>
              <label className={CHOICE_CLASSES}>
                <input
                  type="radio"
                  name={PRICE_MODE_FIELD}
                  value="free"
                  checked={mode === "free"}
                  onChange={() => setMode("free")}
                  className="focus-ring h-5 w-5 shrink-0 accent-primary"
                />
                <span>{PRICE_FREE_LABEL}</span>
              </label>
            </fieldset>
            {mode === "paid" && (
              <label className="flex flex-col gap-1 text-sm">
                {PRICE_INPUT_LABEL}
                <span className="flex w-full max-w-[17.5rem] items-stretch overflow-hidden rounded-[4px] border border-[#8c8472] bg-surface focus-within:shadow-[var(--focus-ring)]">
                  <input
                    name={PRICE_FIELD}
                    type="text"
                    inputMode="numeric"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2.5 text-lg outline-none"
                  />
                  <span aria-hidden="true" className="flex items-center bg-surface-hover px-4 font-bold text-foreground">
                    lekë
                  </span>
                </span>
                <span className="text-sm text-muted">{PRICE_HINT}</span>
              </label>
            )}
            {mode === "paid" && !paidPublishingAvailable && (
              <p className="text-sm text-muted">{PAID_PUBLISHING_CLOSED_LINE}</p>
            )}
            {mode === "paid" && paidPublishingAvailable && !checkoutAvailable && (
              <p className="text-sm text-muted">{BUYING_OPENS_SOON_LINE}</p>
            )}
          </>
        )}
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="pricing-royalty" aria-live="polite">
        <h2 id="pricing-royalty" className="font-serif text-xl font-normal">
          Sa merr
        </h2>
        {preview.kind === "free" ? (
          <>
            <p className="font-medium">Libër falas · 0 lekë</p>
            <p className="text-sm text-muted">{FREE_BOOK_LINE}</p>
          </>
        ) : preview.kind === "empty" ? (
          <p className="text-sm text-muted">{PREVIEW_EMPTY_LINE}</p>
        ) : preview.kind === "too_low" ? (
          <p className="text-sm text-muted">{PREVIEW_TOO_LOW_LINE}</p>
        ) : (
          <>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Çmimi për lexuesin</dt>
              <dd>{groupAllDigits(preview.priceAll)} lekë</dd>
              <dt className="text-muted">Përqindja jote</dt>
              <dd>{preview.percent}%</dd>
              <dt className="font-medium">Ti merr për çdo shitje</dt>
              <dd className="font-medium">{formatShareMinor(preview.authorMinor)}</dd>
            </dl>
            <p className="text-sm text-muted">{ROYALTY_TAX_LINE}</p>
            <p className="text-sm text-muted">{ROYALTY_RATES_LINE}</p>
            {preview.upsell && (
              <p className="text-sm">
                Me {groupAllDigits(preview.upsell.priceAll)} lekë do të merrje {formatShareMinor(preview.upsell.authorMinor)}{" "}
                për çdo shitje ({preview.upsell.percent}%).
              </p>
            )}
          </>
        )}
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="pricing-reader">
        <h2 id="pricing-reader" className="font-serif text-xl font-normal">
          Si do ta shohin lexuesit
        </h2>
        <p className="font-serif text-lg">{title}</p>
        <p className="text-sm text-muted">{penName}</p>
        <p className="font-medium">{readerPrice}</p>
      </section>

      <section className={SECTION_CLASSES} aria-labelledby="pricing-terms">
        <h2 id="pricing-terms" className="font-serif text-xl font-normal">
          Kushtet
        </h2>
        <label className={TICK_CLASSES}>
          <input type="checkbox" name={ACCEPT_TERMS_FIELD} className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-primary" />
          <span>
            {ACCEPT_TERMS_TEXT_BEFORE_LINK}{" "}
            <Link href={TERMS_PAGE_PATH} target="_blank" rel="noopener" className="font-medium underline">
              {ACCEPT_TERMS_LINK_TEXT}
              <span className="sr-only"> (hapet në një skedë të re)</span>
            </Link>
            .
          </span>
        </label>
      </section>

      {missing.length > 0 && (
        <div className="rounded-[4px] border border-border p-4 text-sm" role="status">
          <p className="font-medium">Para dërgimit plotësoni:</p>
          <ul className="mt-2 flex flex-col gap-1">
            {missing.map((m) => (
              <li key={`${m.tab}-${m.label}`}>
                <Link href={editorPath(bookId, m.tab)} className="underline">
                  {m.label}
                </Link>{" "}
                <span className="text-muted">({EDITOR_TABS.find((t) => t.key === m.tab)?.label})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="submit" name="intent" value="save" className={buttonClasses("outline", "md", "min-h-11 rounded-full")}>
          Ruaj draftin
        </button>
        <button
          type="submit"
          name="intent"
          value="send"
          disabled={missing.length > 0}
          className={buttonClasses("primary", "md", "min-h-11 rounded-full")}
        >
          {approvalValid ? PUBLISH_APPROVED_BUTTON : SEND_FOR_REVIEW_BUTTON}
        </button>
      </div>
      {approvalValid && <p className="text-sm text-muted">{PUBLISH_APPROVED_NOTE}</p>}
    </form>
  );
}
