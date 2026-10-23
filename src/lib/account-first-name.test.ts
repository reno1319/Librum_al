import { describe, expect, it } from "vitest";
import { accountFirstName } from "./account-first-name";

const EMAIL = "reno13dante+x@gmail.com";

describe("accountFirstName (HEADER NAME)", () => {
  it("is the first word of the account name", () => {
    expect(accountFirstName("Renato Kalemi", EMAIL)).toBe("Renato");
    expect(accountFirstName("  Ëngjëll \t Çela ", EMAIL)).toBe("Ëngjëll");
  });

  it("is null with no real name: empty, an @, or the email's local part", () => {
    for (const name of [null, undefined, "", "   ", "reno13dante+x", "ana@example.com"]) {
      expect(accountFirstName(name, EMAIL)).toBeNull();
    }
  });

  it("keeps a name that only differs from the local part", () => {
    expect(accountFirstName("Renato", "renato@example.com")).toBe("Renato");
    expect(accountFirstName("Ana", null)).toBe("Ana");
  });
});
