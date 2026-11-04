"use client";

import { useState } from "react";
import Link from "next/link";
import {
  EDITOR_CONTROL_CLASSES,
  EDITOR_FIELD_CLASSES,
  EDITOR_HINT_CLASSES,
  EDITOR_LABEL_CLASSES,
  EditorActionBar,
  EditorSection,
} from "@/components/book-editor-ui";
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
  PRICE_FREE_SUBLINE,
  PRICE_HINT,
  PRICE_INPUT_LABEL,
  PRICE_MODE_FIELD,
  PRICE_PAID_LABEL,
  PRICE_PAID_SUBLINE,
  PRICING_PRICE_HELP,
  PRICING_WHERE_HEADING,
  PRICING_WHERE_LINE,
  PUBLIC_DOMAIN_FREE_ONLY_NOTE,
  PUBLISH_APPROVED_BUTTON,
  PUBLISH_APPROVED_NOTE,
  ROYALTY_HEADING,
  ROYALTY_PERCENT_LABEL,
  ROYALTY_RATES_LINE,
  ROYALTY_TAX_LINE,
  ROYALTY_TOTAL_LABEL,
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

// D1 (mockup v5): the editor's shared look (book-editor-ui.tsx). The
// two ticks count live (Renato 11-04, a): the to-do list names each
// unticked box, and the send button stays a dashed outline with
// "Plotësoni N gjëra më lart" until nothing is missing. The server
// still checks both ticks and every tab (saveBookPricing).
const CHOICE_CLASSES =
  "flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-control bg-surface px-3.5 py-3 has-checked:border-2 has-checked:border-primary has-checked:bg-author-tint has-checked:px-[13px] has-checked:py-[11px]";
const TICK_CLASSES = "flex cursor-pointer items-start gap-2.5 text-sm sm:items-center";
const TICK_INPUT_CLASSES = "focus-ring mt-0.5 h-[18px] w-[18px] shrink-0 accent-primary sm:mt-0";

// The to-do lines for the two ticks on this tab.
export const WORLDWIDE_TODO_LABEL = "Të drejtat për shitje në të gjithë botën";
export const TERMS_TODO_LABEL = "Kushtet e Librum";

export type PricingMissing = { tab: EditorTab; label: string };

export type PricingTodo = { key: string; label: string; tab: EditorTab; href: string };

/**
 * Everything still missing before "Send": the other tabs' gaps (linked
 * to their tab), then each unticked box on this tab (linked to the box).
 */
export function pricingTodo(
  bookId: string,
  missing: PricingMissing[],
  ticks: { worldwide: boolean; terms: boolean },
): PricingTodo[] {
  return [
    ...missing.map((m) => ({ key: `${m.tab}-${m.label}`, label: m.label, tab: m.tab, href: editorPath(bookId, m.tab) })),
    ...(ticks.worldwide
      ? []
      : [{ key: "tick-worldwide", label: WORLDWIDE_TODO_LABEL, tab: "pricing" as const, href: "#pricing-worldwide" }]),
    ...(ticks.terms ? [] : [{ key: "tick-terms", label: TERMS_TODO_LABEL, tab: "pricing" as const, href: "#pricing-terms-tick" }]),
  ];
}

/** The line under the send button while something is missing. */
export function pricingTodoNote(count: number): string | undefined {
  if (count === 0) return undefined;
  return `Plotësoni ${count} ${count === 1 ? "gjë" : "gjëra"} më lart`;
}

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

  const [worldwide, setWorldwide] = useState(false);
  const [terms, setTerms] = useState(false);
  const todo = pricingTodo(bookId, missing, { worldwide, terms });
  const sendLabel = approvalValid ? PUBLISH_APPROVED_BUTTON : SEND_FOR_REVIEW_BUTTON;

  return (
    <form action={action} className="mt-2 flex flex-col gap-2">
      <EditorSection id="pricing-where" title={PRICING_WHERE_HEADING} help={PRICING_WHERE_LINE}>
        <label className={TICK_CLASSES}>
          <input
            id="pricing-worldwide"
            type="checkbox"
            name={WORLDWIDE_RIGHTS_FIELD}
            checked={worldwide}
            onChange={(e) => setWorldwide(e.target.checked)}
            className={TICK_INPUT_CLASSES}
          />
          <span>{WORLDWIDE_RIGHTS_TEXT}.</span>
        </label>
      </EditorSection>

      <EditorSection id="pricing-price" title="Çmimi" help={freeOnly ? undefined : PRICING_PRICE_HELP}>
        {freeOnly ? (
          <>
            <input type="hidden" name={PRICE_MODE_FIELD} value="free" />
            <p className="font-semibold">{PRICE_FREE_LABEL}</p>
            <p className="text-sm text-muted">{PUBLIC_DOMAIN_FREE_ONLY_NOTE}</p>
          </>
        ) : (
          <>
            <fieldset className="m-0 grid gap-2.5 border-0 p-0 sm:grid-cols-2">
              <legend className="sr-only">Çmimi</legend>
              <label className={CHOICE_CLASSES}>
                <input
                  type="radio"
                  name={PRICE_MODE_FIELD}
                  value="paid"
                  checked={mode === "paid"}
                  onChange={() => setMode("paid")}
                  className="focus-ring h-[18px] w-[18px] shrink-0 accent-primary"
                />
                <span>
                  <span className="block font-semibold">{PRICE_PAID_LABEL}</span>
                  <small className="block text-[13px] text-muted">{PRICE_PAID_SUBLINE}</small>
                </span>
              </label>
              <label className={CHOICE_CLASSES}>
                <input
                  type="radio"
                  name={PRICE_MODE_FIELD}
                  value="free"
                  checked={mode === "free"}
                  onChange={() => setMode("free")}
                  className="focus-ring h-[18px] w-[18px] shrink-0 accent-primary"
                />
                <span>
                  <span className="block font-semibold">{PRICE_FREE_LABEL}</span>
                  <small className="block text-[13px] text-muted">{PRICE_FREE_SUBLINE}</small>
                </span>
              </label>
            </fieldset>
            {mode === "paid" && (
              <label className={EDITOR_FIELD_CLASSES}>
                <span className={EDITOR_LABEL_CLASSES}>{PRICE_INPUT_LABEL}</span>
                <span className="flex items-center gap-2">
                  <input
                    name={PRICE_FIELD}
                    type="text"
                    inputMode="numeric"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className={`${EDITOR_CONTROL_CLASSES} max-w-32 text-right`}
                  />
                  <span aria-hidden="true">lekë</span>
                </span>
                <span className={EDITOR_HINT_CLASSES}>{PRICE_HINT}</span>
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
      </EditorSection>

      <EditorSection id="pricing-royalty" title={ROYALTY_HEADING} live>
        {preview.kind === "free" ? (
          <>
            <p className="font-semibold">Libër falas · 0 lekë</p>
            <p className="text-sm text-muted">{FREE_BOOK_LINE}</p>
          </>
        ) : preview.kind === "empty" ? (
          <p className="text-sm text-muted">{PREVIEW_EMPTY_LINE}</p>
        ) : preview.kind === "too_low" ? (
          <p className="text-sm text-muted">{PREVIEW_TOO_LOW_LINE}</p>
        ) : (
          <>
            <p className="text-sm text-foreground">{ROYALTY_TAX_LINE}</p>
            <dl className="grid w-fit grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-[15px] tabular-nums">
              <dt className="text-muted">Çmimi për lexuesin</dt>
              <dd className="m-0 text-right">{groupAllDigits(preview.priceAll)} lekë</dd>
              <dt className="text-muted">{ROYALTY_PERCENT_LABEL}</dt>
              <dd className="m-0 text-right">{preview.percent}%</dd>
              <dt className="border-t border-border pt-1.5 font-bold">{ROYALTY_TOTAL_LABEL}</dt>
              <dd className="m-0 border-t border-border pt-1.5 text-right font-bold">
                {formatShareMinor(preview.authorMinor)}
              </dd>
            </dl>
            <p className="text-[13px] text-muted">{ROYALTY_RATES_LINE}</p>
            {preview.upsell && (
              <p className="text-sm">
                Me {groupAllDigits(preview.upsell.priceAll)} lekë do të merrnit {formatShareMinor(preview.upsell.authorMinor)}{" "}
                për çdo shitje ({preview.upsell.percent}%).
              </p>
            )}
          </>
        )}
      </EditorSection>

      <EditorSection id="pricing-reader" title="Si do ta shohin lexuesit">
        <div>
          <p className="font-serif text-lg">{title}</p>
          <p className="text-[13px] text-muted">{penName}</p>
          <p className="mt-1.5 font-semibold">{readerPrice}</p>
        </div>
      </EditorSection>

      <EditorSection id="pricing-terms" title="Kushtet">
        <label className={TICK_CLASSES}>
          <input
            id="pricing-terms-tick"
            type="checkbox"
            name={ACCEPT_TERMS_FIELD}
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            className={TICK_INPUT_CLASSES}
          />
          <span>
            {ACCEPT_TERMS_TEXT_BEFORE_LINK}{" "}
            <Link href={TERMS_PAGE_PATH} target="_blank" rel="noopener" className="font-medium text-primary underline">
              {ACCEPT_TERMS_LINK_TEXT}
              <span className="sr-only"> (hapet në një skedë të re)</span>
            </Link>
            .
          </span>
        </label>
      </EditorSection>

      {todo.length > 0 && (
        <div className="rounded-lg border border-[#eadfb8] bg-reader-tint px-4 py-3.5 text-sm" role="status">
          <p className="font-semibold">Para dërgimit plotësoni:</p>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-[18px]">
            {todo.map((m) => (
              <li key={m.key}>
                {m.tab === "pricing" ? (
                  <a href={m.href} className="text-primary underline">
                    {m.label}
                  </a>
                ) : (
                  <Link href={m.href} className="text-primary underline">
                    {m.label}
                  </Link>
                )}{" "}
                <span className="text-muted">({EDITOR_TABS.find((t) => t.key === m.tab)?.label})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <EditorActionBar
        backLabel="Përmbajtja"
        primaryLabel={sendLabel}
        primaryIntent="send"
        primaryBlocked={todo.length > 0}
        primaryNote={pricingTodoNote(todo.length)}
        extra={approvalValid ? <p className="text-sm text-muted sm:text-right">{PUBLISH_APPROVED_NOTE}</p> : undefined}
      />
    </form>
  );
}
