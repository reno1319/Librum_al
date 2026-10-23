import { describe, expect, it } from "vitest";
import { buildDashboardGreeting } from "./dashboard-greeting";

const EMAIL = "reno13dante+x@gmail.com";

describe("buildDashboardGreeting (PHONE PASS D2)", () => {
  it("greets by the first word of the account name", () => {
    expect(buildDashboardGreeting("Renato Kalemi", EMAIL)).toBe("Hello, Renato");
    expect(buildDashboardGreeting("Renato", EMAIL)).toBe("Hello, Renato");
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(buildDashboardGreeting("  Ana \t Marku  ", EMAIL)).toBe("Hello, Ana");
    expect(buildDashboardGreeting("Ana\nMarku", EMAIL)).toBe("Hello, Ana");
  });

  it("keeps Albanian letters whole", () => {
    expect(buildDashboardGreeting("Ëngjëll Çela", EMAIL)).toBe("Hello, Ëngjëll");
  });

  it("says just Hello with no name", () => {
    expect(buildDashboardGreeting(null, EMAIL)).toBe("Hello");
    expect(buildDashboardGreeting(undefined, EMAIL)).toBe("Hello");
    expect(buildDashboardGreeting("", EMAIL)).toBe("Hello");
    expect(buildDashboardGreeting("   ", EMAIL)).toBe("Hello");
  });

  // r2 (audit N4): handle_new_user's no-name fallback is the email's
  // local part; never greet with it, or with anything holding an "@".
  it("never shows an email fragment", () => {
    expect(buildDashboardGreeting("reno13dante+x", EMAIL)).toBe("Hello");
    expect(buildDashboardGreeting("  reno13dante+x  ", EMAIL)).toBe("Hello");
    expect(buildDashboardGreeting("reno13dante+x@gmail.com", EMAIL)).toBe("Hello");
    expect(buildDashboardGreeting("ana@example.com", null)).toBe("Hello");
  });

  it("a real name that only differs from the email's local part is kept", () => {
    expect(buildDashboardGreeting("Renato", "renato@example.com")).toBe("Hello, Renato");
    expect(buildDashboardGreeting("Ana", null)).toBe("Hello, Ana");
  });
});
