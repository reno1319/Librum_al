import { describe, expect, it } from "vitest";
import {
  KOSOVO_CODE,
  TAX_COUNTRY_REQUIRED_MESSAGE,
  TAX_LEGAL_NAME_REQUIRED_MESSAGE,
  TAX_NID_INVALID_MESSAGE,
  TAX_NOT_SAVED_MESSAGE,
  TAX_NUMBER_INVALID_MESSAGE,
  TAX_RESIDENCE_REQUIRED_MESSAGE,
  BANK_ALBANIAN_IBAN_INVALID_MESSAGE,
  BANK_IBAN_INVALID_MESSAGE,
  BANK_NOT_SAVED_MESSAGE,
  abroadCountryOptions,
  countryName,
  isAbroadCountry,
  mapBankRpcError,
  mapTaxRpcError,
  maskTaxId,
  normalizeTaxId,
  paymentReadyCount,
  validateTaxDetails,
} from "./payment-logic";

// BUILD 3: the pure parts of the Payment & tax page. Made-up numbers only.
describe("country list (Kosova first)", () => {
  it("starts with Kosova and never lists Albania as abroad", () => {
    const options = abroadCountryOptions();
    expect(options[0]).toEqual({ code: KOSOVO_CODE, name: "Kosova" });
    expect(options.map((o) => o.code)).not.toContain("AL");
    expect(isAbroadCountry("AL")).toBe(false);
    expect(isAbroadCountry("DE")).toBe(true);
    expect(new Set(options.map((o) => o.code)).size).toBe(options.length);
  });

  it("names countries in Albanian", () => {
    expect(countryName("DE")).toBe("Gjermani");
    expect(countryName("XK")).toBe("Kosova");
  });
});

describe("validateTaxDetails", () => {
  it("an author in Albania: NID, normalised", () => {
    expect(
      validateTaxDetails({ residence: "albania", countryCode: "XK", legalName: "  Arta   Test ", taxId: "j1234 5678a" }),
    ).toEqual({ ok: true, countryCode: "AL", legalName: "Arta Test", taxId: "J12345678A" });
  });

  it("refuses a malformed NID", () => {
    for (const taxId of ["", "J1234567A", "123456789A", "J12345678", "J12345678AA"]) {
      expect(validateTaxDetails({ residence: "albania", countryCode: "", legalName: "A", taxId })).toEqual({
        ok: false,
        message: TAX_NID_INVALID_MESSAGE,
      });
    }
  });

  it("an author abroad: country + home tax number (typing help removed)", () => {
    expect(
      validateTaxDetails({ residence: "abroad", countryCode: "xk", legalName: "Arta", taxId: "12-345.678/90" }),
    ).toEqual({ ok: true, countryCode: "XK", legalName: "Arta", taxId: "1234567890" });
  });

  it("abroad refuses Albania, an unknown country, and a too-short number", () => {
    expect(validateTaxDetails({ residence: "abroad", countryCode: "AL", legalName: "A", taxId: "1234" })).toEqual({
      ok: false,
      message: TAX_COUNTRY_REQUIRED_MESSAGE,
    });
    expect(validateTaxDetails({ residence: "abroad", countryCode: "ZZ", legalName: "A", taxId: "1234" })).toEqual({
      ok: false,
      message: TAX_COUNTRY_REQUIRED_MESSAGE,
    });
    expect(validateTaxDetails({ residence: "abroad", countryCode: "DE", legalName: "A", taxId: "123" })).toEqual({
      ok: false,
      message: TAX_NUMBER_INVALID_MESSAGE,
    });
  });

  it("refuses a missing residence choice and a blank or too-long legal name", () => {
    expect(validateTaxDetails({ residence: "", countryCode: "", legalName: "A", taxId: "J12345678A" })).toEqual({
      ok: false,
      message: TAX_RESIDENCE_REQUIRED_MESSAGE,
    });
    expect(validateTaxDetails({ residence: "albania", countryCode: "", legalName: "   ", taxId: "J12345678A" })).toEqual({
      ok: false,
      message: TAX_LEGAL_NAME_REQUIRED_MESSAGE,
    });
    expect(
      validateTaxDetails({ residence: "albania", countryCode: "", legalName: "a".repeat(201), taxId: "J12345678A" }),
    ).toEqual({ ok: false, message: TAX_LEGAL_NAME_REQUIRED_MESSAGE });
  });

  it("normalizeTaxId keeps only letters and digits, upper-cased", () => {
    expect(normalizeTaxId(" ab-12.3/4 ")).toBe("AB1234");
  });
});

describe("maskTaxId", () => {
  it("shows the first two and last two characters only", () => {
    expect(maskTaxId("J12345678A")).toBe("J1••••••8A");
    expect(maskTaxId("1234")).toBe("••••");
    expect(maskTaxId("")).toBe("");
  });
});

describe("paymentReadyCount", () => {
  it("counts the saved parts", () => {
    expect(paymentReadyCount({ hasTaxDetails: false, hasBankAccount: false })).toBe(0);
    expect(paymentReadyCount({ hasTaxDetails: true, hasBankAccount: false })).toBe(1);
    expect(paymentReadyCount({ hasTaxDetails: true, hasBankAccount: true })).toBe(2);
  });
});

describe("RPC error messages", () => {
  it("maps known tax messages and falls back to a generic one", () => {
    expect(mapTaxRpcError("set_author_tax_details: nid format is not valid")).toBe(TAX_NID_INVALID_MESSAGE);
    expect(mapTaxRpcError("set_author_tax_details: tax number format is not valid")).toBe(TAX_NUMBER_INVALID_MESSAGE);
    expect(mapTaxRpcError("set_author_tax_details: country is required")).toBe(TAX_COUNTRY_REQUIRED_MESSAGE);
    expect(mapTaxRpcError("set_author_tax_details: legal name is required")).toBe(TAX_LEGAL_NAME_REQUIRED_MESSAGE);
    expect(mapTaxRpcError("anything else J12345678A")).toBe(TAX_NOT_SAVED_MESSAGE);
  });

  it("maps the bank messages, Albanian rule before the general one", () => {
    expect(
      mapBankRpcError(
        "set_author_payout_destination: iban does not match the expected Albanian IBAN format (AL + 26 digits/letters)",
      ),
    ).toBe(BANK_ALBANIAN_IBAN_INVALID_MESSAGE);
    expect(mapBankRpcError("set_author_payout_destination: iban does not match the expected IBAN format")).toBe(
      BANK_IBAN_INVALID_MESSAGE,
    );
    expect(mapBankRpcError("set_author_payout_destination: iban fails checksum validation -- x")).toBe(
      BANK_IBAN_INVALID_MESSAGE,
    );
    expect(mapBankRpcError("boom")).toBe(BANK_NOT_SAVED_MESSAGE);
  });
});
