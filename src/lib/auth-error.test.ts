import { describe, expect, it } from "vitest";
import { translateAuthErrorMessage } from "./auth-error";

describe("translateAuthErrorMessage", () => {
  it("translates a known Supabase message into Librum wording", () => {
    expect(translateAuthErrorMessage("Invalid login credentials")).toBe(
      "Emaili ose fjalëkalimi nuk është i saktë. Provoni përsëri.",
    );
  });

  // AUTH-1C: closes the login user-enumeration signal AUTH-1A found --
  // "Email not confirmed" must be indistinguishable from an ordinary
  // wrong-password failure, not a distinct, more-informative message.
  it("translates Email not confirmed to the exact same generic message as invalid credentials (no enumeration signal)", () => {
    expect(translateAuthErrorMessage("Email not confirmed")).toBe(
      translateAuthErrorMessage("Invalid login credentials"),
    );
    expect(translateAuthErrorMessage("Email not confirmed")).toBe(
      "Emaili ose fjalëkalimi nuk është i saktë. Provoni përsëri.",
    );
  });

  // PEOPLE-2: a ban is reported before the password is checked.
  it("translates User is banned to the same generic message as invalid credentials", () => {
    expect(translateAuthErrorMessage("User is banned")).toBe(translateAuthErrorMessage("Invalid login credentials"));
  });

  it("translates User already registered", () => {
    expect(translateAuthErrorMessage("User already registered")).toBe(
      "Ka tashmë një llogari me këtë email. Provoni të hyni.",
    );
  });

  it("translates the password-length message", () => {
    expect(translateAuthErrorMessage("Password should be at least 6 characters")).toBe(
      "Fjalëkalimi duhet të ketë të paktën 6 karaktere.",
    );
  });

  it("falls back to the original message for an unmapped/unknown error, never hiding it", () => {
    expect(translateAuthErrorMessage("Some unexpected provider error")).toBe(
      "Some unexpected provider error",
    );
  });

  it("passes through a locally-generated (non-Supabase) message unchanged", () => {
    expect(translateAuthErrorMessage("Shkruani emailin.")).toBe("Shkruani emailin.");
  });

  it("returns null for a null/undefined/empty message", () => {
    expect(translateAuthErrorMessage(null)).toBeNull();
    expect(translateAuthErrorMessage(undefined)).toBeNull();
    expect(translateAuthErrorMessage("")).toBeNull();
  });
});
