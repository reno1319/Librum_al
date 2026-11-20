import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { authorGreetingName, authorRecipient } = await import("./author-recipient");

// AUTHOR-EMAILS (mail10 a): who the author emails greet.
describe("authorGreetingName", () => {
  const emailUser = { email: "ana@example.com", app_metadata: { provider: "email" }, user_metadata: {} };
  const googleUser = (meta: Record<string, unknown>) => ({
    email: "arben.test@example.test",
    app_metadata: { provider: "google" },
    user_metadata: meta,
  });

  it("an email sign-up: the account name, tidied", () => {
    expect(authorGreetingName(emailUser, "  Ana   Hoxha ")).toBe("Ana Hoxha");
  });

  it("an email sign-up with no usable name: none", () => {
    expect(authorGreetingName(emailUser, "   ")).toBeNull();
    expect(authorGreetingName(emailUser, null)).toBeNull();
    expect(authorGreetingName(emailUser, 7)).toBeNull();
  });

  it("an email sign-up whose name looks like the address still keeps it (only Google gets the swap)", () => {
    expect(authorGreetingName(emailUser, "ana")).toBe("ana");
  });

  it("Google with the automatic name: Google's full_name, then name, then none", () => {
    expect(authorGreetingName(googleUser({ full_name: "Arben Hoxha", name: "A H" }), "arben.test")).toBe("Arben Hoxha");
    expect(authorGreetingName(googleUser({ name: "Arben H" }), "arben.test")).toBe("Arben H");
    expect(authorGreetingName(googleUser({}), "arben.test")).toBeNull();
    expect(authorGreetingName(googleUser({ full_name: 5 }), null)).toBeNull();
  });

  it("Google with a name the person set: that name", () => {
    expect(authorGreetingName(googleUser({ full_name: "Arben Hoxha" }), "Beni")).toBe("Beni");
  });

  it("caps a very long name", () => {
    expect(authorGreetingName(emailUser, "x".repeat(200))).toHaveLength(80);
  });

  it("copes with missing metadata", () => {
    expect(authorGreetingName({}, "Ana")).toBe("Ana");
    expect(authorGreetingName({ app_metadata: { provider: "google" }, user_metadata: null }, null)).toBeNull();
  });
});

describe("authorRecipient", () => {
  function admin(user: unknown, displayName: unknown) {
    const filters: Array<[string, unknown]> = [];
    return {
      filters,
      client: {
        auth: { admin: { getUserById: async () => ({ data: { user }, error: null }) } },
        from: (table: string) => {
          expect(table).toBe("profiles");
          const chain = {
            select: () => chain,
            eq: (c: string, v: unknown) => {
              filters.push([c, v]);
              return chain;
            },
            maybeSingle: async () => ({ data: { display_name: displayName }, error: null }),
          };
          return chain;
        },
      } as never,
    };
  }

  it("the address and the greeting name of that author", async () => {
    const a = admin({ email: "ana@example.com", app_metadata: { provider: "email" } }, "Ana");
    expect(await authorRecipient(a.client, "id-1")).toEqual({ email: "ana@example.com", name: "Ana" });
    expect(a.filters).toEqual([["id", "id-1"]]);
  });

  it("null when there is no address", async () => {
    expect(await authorRecipient(admin(null, "Ana").client, "id-1")).toBeNull();
    expect(await authorRecipient(admin({ email: "" }, "Ana").client, "id-1")).toBeNull();
  });
});
