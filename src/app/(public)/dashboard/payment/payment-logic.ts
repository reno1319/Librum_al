// BUILD 3 (Renato 11-23): "Të dhënat e pagesës" -- the pure parts of the
// Payment & tax page: the country list, the input checks (the same
// rules the database applies in set_author_tax_details(), migration
// 20261123200000; the database stays the authority), the masking of
// saved numbers, and every message the page can show.

export const ALBANIA_CODE = "AL";
export const KOSOVO_CODE = "XK";

// t1 a: one flat rate for every author, in Albania or abroad.
export const WITHHOLDING_PERCENT = 15;

// ISO 3166-1 alpha-2, plus XK (Kosovo). Albania itself is not in the
// "abroad" list: it is the other radio choice.
const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR",
  "BS", "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL",
  "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO",
  "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA",
  "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT",
  "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO",
  "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP",
  "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR",
  "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL",
  "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN",
  "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD",
  "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX",
  "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT",
  "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN",
  "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW", KOSOVO_CODE,
] as const;

const ABROAD_CODES: ReadonlySet<string> = new Set(COUNTRY_CODES);

export function isAbroadCountry(code: string): boolean {
  return ABROAD_CODES.has(code);
}

export function countryName(code: string): string {
  if (code === KOSOVO_CODE) return "Kosova";
  if (code === ALBANIA_CODE) return "Shqipëria";
  try {
    return new Intl.DisplayNames(["sq"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export type CountryOption = { code: string; name: string };

// Kosova first (the decision on the pictures), then everything else by
// its Albanian name.
export function abroadCountryOptions(): CountryOption[] {
  const rest = COUNTRY_CODES.filter((code) => code !== KOSOVO_CODE)
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, "sq"));
  return [{ code: KOSOVO_CODE, name: countryName(KOSOVO_CODE) }, ...rest];
}

// The same normalising the database does: spaces, dots, dashes and
// slashes are typing help only.
export function normalizeTaxId(raw: string): string {
  return raw.replace(/[\s./-]+/g, "").toUpperCase();
}

export function normalizeLegalName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export const LEGAL_NAME_MAX_LENGTH = 200;

export type TaxDetailsInput = {
  // "albania" or "abroad"; anything else is refused.
  residence: string;
  countryCode: string;
  legalName: string;
  taxId: string;
};

export type TaxDetailsValidation =
  | { ok: true; countryCode: string; legalName: string; taxId: string }
  | { ok: false; message: string };

export function validateTaxDetails(input: TaxDetailsInput): TaxDetailsValidation {
  const legalName = normalizeLegalName(input.legalName);
  const taxId = normalizeTaxId(input.taxId);
  if (input.residence !== "albania" && input.residence !== "abroad") {
    return { ok: false, message: TAX_RESIDENCE_REQUIRED_MESSAGE };
  }
  const countryCode = input.residence === "albania" ? ALBANIA_CODE : input.countryCode.trim().toUpperCase();
  if (input.residence === "abroad" && !isAbroadCountry(countryCode)) {
    return { ok: false, message: TAX_COUNTRY_REQUIRED_MESSAGE };
  }
  if (legalName === "" || legalName.length > LEGAL_NAME_MAX_LENGTH) {
    return { ok: false, message: TAX_LEGAL_NAME_REQUIRED_MESSAGE };
  }
  if (countryCode === ALBANIA_CODE && !/^[A-Z][0-9]{8}[A-Z]$/.test(taxId)) {
    return { ok: false, message: TAX_NID_INVALID_MESSAGE };
  }
  if (countryCode !== ALBANIA_CODE && !/^[A-Z0-9]{4,30}$/.test(taxId)) {
    return { ok: false, message: TAX_NUMBER_INVALID_MESSAGE };
  }
  return { ok: true, countryCode, legalName, taxId };
}

// A saved NID or tax number, shown hidden: the first two and the last
// two characters only (J1••••••8A). Never throws.
export function maskTaxId(taxId: string): string {
  const value = taxId.replace(/\s+/g, "");
  if (value.length <= 4) return "•".repeat(value.length);
  return value.slice(0, 2) + "•".repeat(value.length - 4) + value.slice(-2);
}

// The "N nga 2 gati" count.
export function paymentReadyCount(state: { hasTaxDetails: boolean; hasBankAccount: boolean }): number {
  return (state.hasTaxDetails ? 1 : 0) + (state.hasBankAccount ? 1 : 0);
}

// Known set_author_tax_details() messages (none echoes the input).
export function mapTaxRpcError(message: string): string {
  if (message.includes("country is required")) return TAX_COUNTRY_REQUIRED_MESSAGE;
  if (message.includes("legal name is required")) return TAX_LEGAL_NAME_REQUIRED_MESSAGE;
  if (message.includes("nid format is not valid")) return TAX_NID_INVALID_MESSAGE;
  if (message.includes("tax number format is not valid")) return TAX_NUMBER_INVALID_MESSAGE;
  return TAX_NOT_SAVED_MESSAGE;
}

// Known set_author_payout_destination() messages (migration 055, and
// the foreign-IBAN rule of 20261123200000). None echoes the input.
export function mapBankRpcError(message: string): string {
  if (message.includes("beneficiary_name is required")) return BANK_NAME_REQUIRED_MESSAGE;
  if (message.includes("iban is required")) return BANK_IBAN_REQUIRED_MESSAGE;
  if (message.includes("does not match the expected Albanian IBAN format")) return BANK_ALBANIAN_IBAN_INVALID_MESSAGE;
  if (message.includes("does not match the expected IBAN format")) return BANK_IBAN_INVALID_MESSAGE;
  if (message.includes("fails checksum validation")) return BANK_IBAN_INVALID_MESSAGE;
  return BANK_NOT_SAVED_MESSAGE;
}

export const PAYMENT_PAGE_PATH = "/dashboard/payment";

export const TAX_RESIDENCE_REQUIRED_MESSAGE = "Zgjidhni ku paguani tatimet mbi të ardhurat.";
export const TAX_COUNTRY_REQUIRED_MESSAGE = "Zgjidhni shtetin ku paguani tatimet.";
export const TAX_LEGAL_NAME_REQUIRED_MESSAGE = "Shkruani emrin tuaj të plotë ligjor.";
export const TAX_NID_INVALID_MESSAGE =
  "Ky nuk duket si numër personal (NID). Ka 10 shenja: një shkronjë, 8 shifra dhe një shkronjë.";
export const TAX_NUMBER_INVALID_MESSAGE =
  "Ky nuk duket si numër tatimor. Shkruani vetëm shkronjat dhe shifrat e tij.";
export const TAX_NOT_SAVED_MESSAGE = "Të dhënat tatimore nuk u ruajtën. Provoni përsëri.";
export const TAX_SAVED_MESSAGE = "Të dhënat tatimore u ruajtën.";
export const TAX_LOAD_FAILED_MESSAGE = "Të dhënat e pagesës nuk u ngarkuan. Provoni përsëri.";

export const BANK_NAME_REQUIRED_MESSAGE = "Shkruani emrin e mbajtësit të llogarisë.";
export const BANK_IBAN_REQUIRED_MESSAGE = "Shkruani IBAN-in tuaj.";
export const BANK_BOTH_REQUIRED_MESSAGE = "Plotësoni edhe emrin e mbajtësit të llogarisë, edhe IBAN-in.";
export const BANK_ALBANIAN_IBAN_INVALID_MESSAGE =
  "Ky nuk duket si IBAN i vlefshëm shqiptar (duhet të fillojë me AL dhe të vazhdojë me 26 shifra ose shkronja).";
export const BANK_IBAN_INVALID_MESSAGE = "Ky IBAN nuk duket i vlefshëm. Kontrollojeni numrin dhe provoni përsëri.";
export const BANK_NOT_SAVED_MESSAGE = "Të dhënat bankare nuk u ruajtën. Kontrolloni të dhënat dhe provoni përsëri.";
export const BANK_SAVED_MESSAGE = "Të dhënat bankare u ruajtën.";

// The editor's to-do line and the publish refusal (a paid book only).
export const PAYMENT_DETAILS_TODO_LABEL = "Të dhënat e pagesës";
export const PAYMENT_DETAILS_TODO_TAB = "Paratë";
export const PAYMENT_DETAILS_MISSING_MESSAGE =
  "Para se të dërgoni një libër me çmim, plotësoni të dhënat e pagesës te Paratë › Të dhënat e pagesës.";
