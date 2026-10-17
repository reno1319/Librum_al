import { beforeEach, describe, expect, it, vi } from "vitest";

// BECOME-AUTHOR-1: the dashboard boundary sends a reader to the
// become-author section of /account, an author through, and every other
// role home -- it never lets a non-author in.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

let role: unknown;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: role === undefined ? null : { role } }) }) }),
    }),
  }),
}));

const { default: DashboardLayout } = await import("./layout");

async function run(): Promise<string> {
  try {
    await DashboardLayout({ children: null });
    return "rendered";
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
}

describe("DashboardLayout role boundary", () => {
  beforeEach(() => {
    role = undefined;
  });

  it("lets an author through", async () => {
    role = "author";
    expect(await run()).toBe("rendered");
  });

  it("sends a reader to the become-author section of their account", async () => {
    role = "reader";
    expect(await run()).toBe("/account#become-author");
  });

  it.each(["admin", null, undefined, "Author"])("sends %s home", async (value) => {
    role = value;
    expect(await run()).toBe("/");
  });
});
