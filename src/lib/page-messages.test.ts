import { describe, expect, it } from "vitest";

import { AUTH_GENERIC_ERROR_MESSAGE } from "@/lib/auth-page-messages";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

const OWN_ERROR = "Ky libër nuk mund të blihet tani";
const OWN_SUCCESS = "Seria u krijua";

describe("pageErrorMessage", () => {
  it("shows our own message as it is", () => {
    expect(pageErrorMessage(OWN_ERROR)).toBe(OWN_ERROR);
  });

  it("turns any other text into the generic message", () => {
    expect(pageErrorMessage("Telefononi 069 000 0000 për rimbursim")).toBe(AUTH_GENERIC_ERROR_MESSAGE);
    expect(pageErrorMessage(`${OWN_ERROR} `)).toBe(AUTH_GENERIC_ERROR_MESSAGE);
    expect(pageErrorMessage(OWN_SUCCESS)).toBe(AUTH_GENERIC_ERROR_MESSAGE);
  });

  it("treats a repeated ?error= as unknown", () => {
    expect(pageErrorMessage([OWN_ERROR, OWN_ERROR])).toBe(AUTH_GENERIC_ERROR_MESSAGE);
  });

  it("shows nothing without a message", () => {
    expect(pageErrorMessage(undefined)).toBeNull();
    expect(pageErrorMessage("")).toBeNull();
  });
});

describe("pageSuccessMessage", () => {
  it("shows our own message as it is", () => {
    expect(pageSuccessMessage(OWN_SUCCESS)).toBe(OWN_SUCCESS);
  });

  it("shows nothing for any other text", () => {
    expect(pageSuccessMessage("Pagesa u krye. Shkruani kartën përsëri këtu.")).toBeNull();
    expect(pageSuccessMessage(OWN_ERROR)).toBeNull();
    expect(pageSuccessMessage([OWN_SUCCESS])).toBeNull();
    expect(pageSuccessMessage("")).toBeNull();
    expect(pageSuccessMessage(undefined)).toBeNull();
  });
});
