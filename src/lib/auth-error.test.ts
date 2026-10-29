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

  // SQ-16 (Renato 10-29, "2. a"): unknown text is never shown as-is.
  it("shows the generic Albanian error for an unmapped/unknown message, never the raw text", () => {
    expect(translateAuthErrorMessage("Some unexpected provider error")).toBe("Diçka nuk shkoi. Provoni përsëri.");
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

// SQ-16: the remaining Supabase messages are Albanian too.
describe("translateAuthErrorMessage (SQ-16)", () => {
  it.each([
    ["Email rate limit exceeded", "Janë dërguar shumë emaile për momentin. Prisni pak dhe provoni përsëri."],
    ["Request rate limit reached", "Shumë përpjekje në pak kohë. Prisni pak dhe provoni përsëri."],
    ["A user with this email address has already been registered", "Ka tashmë një llogari me këtë email. Provoni të hyni."],
    ["New password should be different from the old password.", "Fjalëkalimi i ri duhet të jetë ndryshe nga ai i vjetri."],
    [
      "Password is known to be weak and easy to guess, please choose a different one.",
      "Ky fjalëkalim është i dobët dhe i lehtë për t'u gjetur. Zgjidhni një tjetër.",
    ],
    ["Signups not allowed for this instance", "Regjistrimet janë të mbyllura për momentin."],
    ["Unable to validate email address: invalid format", "Ky email nuk është i vlefshëm. Kontrolloni dhe provoni përsëri."],
    ["Auth session missing!", "Seanca juaj ka mbaruar. Kërkoni një lidhje të re dhe provoni përsëri."],
    ["Password should be at least 6 characters.", "Fjalëkalimi duhet të ketë të paktën 6 karaktere."],
    ["Password should be at least 8 characters", "Fjalëkalimi duhet të ketë të paktën 8 karaktere."],
  ])("translates %j", (input, expected) => {
    expect(translateAuthErrorMessage(input)).toBe(expected);
  });

  it("translates the wait-before-retry message with its number", () => {
    expect(translateAuthErrorMessage("For security purposes, you can only request this after 37 seconds.")).toBe(
      "Për arsye sigurie, mund ta provoni sërish pas 37 sekondash.",
    );
    expect(translateAuthErrorMessage("For security purposes, you can only request this after 1 second.")).toBe(
      "Për arsye sigurie, mund ta provoni sërish pas 1 sekonde.",
    );
  });

  it("never echoes the typed address from an invalid-email message", () => {
    const out = translateAuthErrorMessage('Email address "someone@example.com" is invalid');
    expect(out).toBe("Ky email nuk është i vlefshëm. Kontrolloni dhe provoni përsëri.");
    expect(out).not.toContain("example.com");
  });

  it("translates the password-strength message whatever characters it lists", () => {
    expect(
      translateAuthErrorMessage("Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, 0123456789"),
    ).toBe("Fjalëkalimi nuk i plotëson kërkesat e sigurisë. Zgjidhni një fjalëkalim më të fortë.");
  });

  it("does not look up inherited object keys", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(translateAuthErrorMessage(key)).toBe("Diçka nuk shkoi. Provoni përsëri.");
    }
  });

  // SQ-16 r1 audit F1: GoTrue sends this one in lowercase.
  it("matches Supabase messages whatever their letter case", () => {
    const expected = "Janë dërguar shumë emaile për momentin. Prisni pak dhe provoni përsëri.";
    expect(translateAuthErrorMessage("email rate limit exceeded")).toBe(expected);
    expect(translateAuthErrorMessage("Email rate limit exceeded")).toBe(expected);
    expect(translateAuthErrorMessage("invalid login credentials")).toBe(
      "Emaili ose fjalëkalimi nuk është i saktë. Provoni përsëri.",
    );
  });

  // SQ-16 r1 audit N2: GoTrue joins several password failures.
  it("translates a joined password message sentence by sentence", () => {
    expect(
      translateAuthErrorMessage(
        "Password should be at least 8 characters. Password is known to be weak and easy to guess, please choose a different one.",
      ),
    ).toBe(
      "Fjalëkalimi duhet të ketë të paktën 8 karaktere. Ky fjalëkalim është i dobët dhe i lehtë për t'u gjetur. Zgjidhni një tjetër.",
    );
    expect(
      translateAuthErrorMessage(
        "Password should be at least 8 characters. Password should contain at least one character of each: abc, 123.",
      ),
    ).toBe(
      "Fjalëkalimi duhet të ketë të paktën 8 karaktere. Fjalëkalimi nuk i plotëson kërkesat e sigurisë. Zgjidhni një fjalëkalim më të fortë.",
    );
  });

  it("a joined message with one unknown sentence gets the generic error, never part-English", () => {
    expect(translateAuthErrorMessage("Password should be at least 8 characters. Click evil.example now.")).toBe(
      "Diçka nuk shkoi. Provoni përsëri.",
    );
  });

  it("crafted text in the address is never shown", () => {
    for (const text of [
      "Your account is locked. Call +355 69 000 0000 to unlock it.",
      "Llogaria juaj u bllokua. Shkoni te evil.example",
      "Plotësoni të gjitha fushat. Shkoni te evil.example",
    ]) {
      expect(translateAuthErrorMessage(text)).toBe("Diçka nuk shkoi. Provoni përsëri.");
    }
  });

  it("keeps a local Albanian message that ends in a full stop unchanged", () => {
    expect(translateAuthErrorMessage("Fjalëkalimet nuk përputhen.")).toBe("Fjalëkalimet nuk përputhen.");
  });
});

describe("Librum's own sign-in page messages (SQ-16)", () => {
  it("every own message is shown unchanged", async () => {
    const { OWN_AUTH_ERROR_MESSAGES } = await import("./auth-page-messages");
    expect(OWN_AUTH_ERROR_MESSAGES.size).toBeGreaterThanOrEqual(14);
    for (const message of OWN_AUTH_ERROR_MESSAGES) {
      expect(translateAuthErrorMessage(message)).toBe(message);
    }
  });

  it("the login page's success box shows only the password-changed line", async () => {
    const { authSuccessMessage, AUTH_PASSWORD_CHANGED_MESSAGE } = await import("./auth-page-messages");
    expect(authSuccessMessage(AUTH_PASSWORD_CHANGED_MESSAGE)).toBe(AUTH_PASSWORD_CHANGED_MESSAGE);
    expect(authSuccessMessage("Llogaria juaj u verifikua. Shkoni te evil.example")).toBeNull();
    expect(authSuccessMessage("1")).toBeNull();
    expect(authSuccessMessage(undefined)).toBeNull();
  });

  // Every message the sign-in actions and the callback send must come
  // from auth-page-messages.ts (or be a Supabase message), or the page
  // would show the generic error instead of it.
  it("the actions and the callback send no message literal to a sign-in page", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const file of ["src/app/(public)/auth/actions.ts", "src/app/(public)/auth/callback/route.ts"]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/(error|success)=\$\{encodeURIComponent\(\s*["'`]/);
      expect(source, file).not.toMatch(/loginErrorPath\(\s*["'`]/);
    }
  });
});
