import {
  MAXIMUM_CATALOG_PRICE_ALL,
  MINIMUM_PAID_CATALOG_PRICE_ALL,
  groupAllDigits,
  parseCatalogPriceAll,
} from "@/lib/catalog-price";
import {
  REDUCED_ROYALTY_PERCENT,
  STANDARD_ROYALTY_FROM_ALL,
  STANDARD_ROYALTY_PERCENT,
  librumShareMinor,
  royaltyPercentForPaidMinor,
} from "@/lib/royalty";
import type { RightsBasis } from "@/lib/types";

// BD15 P4: the new editor's Pricing tab (PLAN-BD15-r1 §2.5; mockup
// "Çmimi"). Pure rules shared by the client form (live preview) and the
// server action (the only authority). No server-only imports.
//
// - One lek price. "Falas" (0) is open to every author; a paid price is
//   99 to 100 000, whole lek (parseCatalogPriceAll, the same parser every
//   other price box uses).
// - A public-domain book (rights basis public_domain) is free only: the
//   price is 0 whatever the form says.
// - The royalty preview uses the D3 rates (src/lib/royalty.ts). DISPLAY
//   ONLY: checkout and the ledger still freeze 8000 bps until the POK
//   build (BD2 answer 1a, Master List N6).
// - Two ticks, both required to send, unticked on every send (Renato
//   11-04, Q2 a). Each send records them (book-rights.ts).

export type PriceMode = "free" | "paid";

export const PRICE_MODE_FIELD = "priceMode";
export const PRICE_FIELD = "price";
export const WORLDWIDE_RIGHTS_FIELD = "worldwideRights";
export const ACCEPT_TERMS_FIELD = "acceptAuthorTerms";

export function parsePriceMode(raw: unknown): PriceMode | null {
  return raw === "free" || raw === "paid" ? raw : null;
}

/** True when this rights basis may only be free (PLAN §2.5). */
export function isFreeOnlyRightsBasis(basis: RightsBasis | null | undefined): boolean {
  return basis === "public_domain";
}

export type ResolvedPricing = { ok: true; priceAll: number } | { ok: false; reason: "missing_mode" | "invalid_price" };

/**
 * The price a Pricing form asks for. A free-only book is always 0. A
 * paid price must be a valid whole-lek catalog price that is not 0.
 */
export function resolvePricingSubmission(input: {
  mode: unknown;
  price: unknown;
  rightsBasis: RightsBasis | null | undefined;
}): ResolvedPricing {
  if (isFreeOnlyRightsBasis(input.rightsBasis)) return { ok: true, priceAll: 0 };
  const mode = parsePriceMode(input.mode);
  if (mode === null) return { ok: false, reason: "missing_mode" };
  if (mode === "free") return { ok: true, priceAll: 0 };
  const parsed = parseCatalogPriceAll(input.price);
  if (!parsed.ok || parsed.priceAll === 0) return { ok: false, reason: "invalid_price" };
  return { ok: true, priceAll: parsed.priceAll };
}

/** Both ticks present ("on", the browser's value for a ticked box). */
export function hasSendTicks(formData: { get(name: string): unknown }): boolean {
  return formData.get(WORLDWIDE_RIGHTS_FIELD) === "on" && formData.get(ACCEPT_TERMS_FIELD) === "on";
}

export type RoyaltyPreview =
  | { kind: "free" }
  | { kind: "empty" }
  | { kind: "too_low" }
  | {
      kind: "paid";
      priceAll: number;
      percent: number;
      authorMinor: number;
      // Below 199 lek: what the author would get per sale at 199 lek.
      upsell: { priceAll: number; authorMinor: number; percent: number } | null;
    };

const MINOR = 100;

/** The author's share of one sale at this catalog price, in ALL minor units (qindarka). */
export function authorShareMinor(priceAll: number): number {
  const paidMinor = priceAll * MINOR;
  return paidMinor - librumShareMinor(paidMinor);
}

/** "693 lekë", "69,30 lekë" (Albanian: dot groups thousands, comma for qindarka). */
export function formatShareMinor(minor: number): string {
  const whole = Math.floor(minor / MINOR);
  const rest = minor % MINOR;
  const digits = groupAllDigits(whole);
  return rest === 0 ? `${digits} lekë` : `${digits},${String(rest).padStart(2, "0")} lekë`;
}

/** What the preview box shows for the form's current values. */
export function royaltyPreview(mode: PriceMode | null, rawPrice: string): RoyaltyPreview {
  if (mode === "free") return { kind: "free" };
  if (mode !== "paid") return { kind: "empty" };
  const trimmed = rawPrice.trim();
  if (trimmed === "") return { kind: "empty" };
  const parsed = parseCatalogPriceAll(trimmed);
  if (!parsed.ok || parsed.priceAll === 0) return { kind: "too_low" };
  const priceAll = parsed.priceAll;
  const percent = royaltyPercentForPaidMinor(priceAll * MINOR);
  return {
    kind: "paid",
    priceAll,
    percent,
    authorMinor: authorShareMinor(priceAll),
    upsell:
      priceAll < STANDARD_ROYALTY_FROM_ALL
        ? {
            priceAll: STANDARD_ROYALTY_FROM_ALL,
            authorMinor: authorShareMinor(STANDARD_ROYALTY_FROM_ALL),
            percent: STANDARD_ROYALTY_PERCENT,
          }
        : null,
  };
}

// ---- Words (Albanian, from the approved mockup) ----

export const PRICING_WHERE_HEADING = "Ku shitet";
export const PRICING_WHERE_LINE = "Librum shet në të gjithë botën, në një treg të vetëm: librum.al.";
export const WORLDWIDE_RIGHTS_TEXT = "Kam të drejtat për ta shitur këtë libër në të gjithë botën";
export const ACCEPT_TERMS_TEXT_BEFORE_LINK = "Konfirmoj që kam të drejtat e këtij libri dhe pranoj";
export const ACCEPT_TERMS_LINK_TEXT = "Kushtet e Librum për autorët";
/** The Terms tick as one sentence, as it is recorded. */
export const ACCEPT_TERMS_TEXT = `${ACCEPT_TERMS_TEXT_BEFORE_LINK} ${ACCEPT_TERMS_LINK_TEXT}`;
export const TERMS_PAGE_PATH = "/kushtet";

export const PRICE_PAID_LABEL = "Me pagesë";
export const PRICE_FREE_LABEL = "Falas";
export const PRICE_INPUT_LABEL = "Çmimi në lekë";
export const PRICE_HINT = `Minimumi ${MINIMUM_PAID_CATALOG_PRICE_ALL} lekë. Një çmim i vetëm, në lekë.`;
export const PUBLIC_DOMAIN_FREE_ONLY_NOTE =
  "Librat e domenit publik në Librum janë vetëm falas.";
export const FREE_BOOK_LINE = "Lexuesit e shkarkojnë falas pasi hyjnë në llogari.";
export const PREVIEW_EMPTY_LINE = "Shkruaj një çmim për të parë sa merr.";
export const PREVIEW_TOO_LOW_LINE = `Çmimi më i ulët është ${MINIMUM_PAID_CATALOG_PRICE_ALL} lekë.`;
// Renato 11-04 Q1 b: the agreed sentence, unchanged. POK build: name the
// rate for authors outside Albania once their country is known.
export const ROYALTY_TAX_LINE = "Shuma është para tatimit 15% që mbahet në burim.";
export const ROYALTY_RATES_LINE = `${REDUCED_ROYALTY_PERCENT}% për çmime nën ${STANDARD_ROYALTY_FROM_ALL} lekë, ${STANDARD_ROYALTY_PERCENT}% nga ${STANDARD_ROYALTY_FROM_ALL} lekë e lart.`;
export const BUYING_OPENS_SOON_LINE =
  "Blerjet hapen së shpejti. Deri atëherë libri yt mund të dalë live, por butoni “Bli” nuk është ende aktiv.";
export const PAID_PUBLISHING_CLOSED_LINE =
  "Publikimi me pagesë nuk ka nisur ende. Librat falas mund t'i publikoni që tani.";

export const SEND_FOR_REVIEW_BUTTON = "Dërgo për shqyrtim";
export const PUBLISH_APPROVED_BUTTON = "Publiko";

// Messages (page-messages.ts allowlist).
export const PRICE_MODE_MISSING_MESSAGE = "Zgjidhni “Me pagesë” ose “Falas”.";
export const PRICE_INVALID_MESSAGE = `Shkruani një çmim në lekë të plota, nga ${MINIMUM_PAID_CATALOG_PRICE_ALL} deri në ${groupAllDigits(MAXIMUM_CATALOG_PRICE_ALL)}, ose zgjidhni “Falas”.`;
export const SEND_TICKS_MISSING_MESSAGE =
  "Për ta dërguar për shqyrtim, shënoni të dyja kutitë: të drejtat në gjithë botën dhe Kushtet.";
export const SEND_INCOMPLETE_MESSAGE =
  "Libri nuk është gati për shqyrtim. Plotësoni të gjitha pjesët që mungojnë dhe provoni përsëri.";
export const SEND_CONFIRMATION_NOT_SAVED_MESSAGE =
  "Konfirmimi juaj nuk u ruajt, ndaj libri nuk u dërgua. Provoni përsëri.";
export const EBOOK_RESTAMP_FAILED_MESSAGE =
  "Titulli brenda librit elektronik nuk u përditësua dot, ndaj libri nuk u dërgua. Provoni përsëri.";
