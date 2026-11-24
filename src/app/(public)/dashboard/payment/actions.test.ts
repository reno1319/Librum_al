import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// BUILD 3: the Payment & tax page's actions. Made-up values only.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockRpc = vi.fn();
const mockGetUser = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ rpc: mockRpc, auth: { getUser: mockGetUser } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const AUTHOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const { saveTaxDetails, savePaymentBankAccount } = await import("./actions");

function form(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

async function target(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return decodeURIComponent(error.target);
    throw error;
  }
  throw new Error("no redirect");
}

describe("source guards", () => {
  const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
  it("uses only the author's own session client", () => {
    expect(source).not.toMatch(/@\/lib\/supabase\/admin/);
    expect(source).not.toMatch(/createAdminClient/);
  });
  it("never sends an author id to the write RPCs", () => {
    expect(source).not.toMatch(/p_author_id/);
  });
  it("is not behind the old Bilanci bank switch (sg1 a)", () => {
    expect(source).not.toMatch(/isBankPayoutSetupEnabled\(/);
  });
});

describe("saveTaxDetails", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("saves an author in Albania through set_author_tax_details, normalised", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const to = await target(() =>
      saveTaxDetails(form({ residence: "albania", legalName: " Arta  Test ", taxId: "j12345678a", countryCode: "XK" })),
    );
    expect(mockRpc).toHaveBeenCalledWith("set_author_tax_details", {
      p_country_code: "AL",
      p_legal_name: "Arta Test",
      p_tax_id: "J12345678A",
    });
    expect(to).toBe("/dashboard/payment?success=Të dhënat tatimore u ruajtën.");
  });

  it("saves an author abroad with country and home tax number", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await target(() => saveTaxDetails(form({ residence: "abroad", countryCode: "XK", legalName: "Arta", taxId: "1234567890" })));
    expect(mockRpc).toHaveBeenCalledWith("set_author_tax_details", {
      p_country_code: "XK",
      p_legal_name: "Arta",
      p_tax_id: "1234567890",
    });
  });

  it("refuses bad input before any RPC", async () => {
    const to = await target(() => saveTaxDetails(form({ residence: "albania", legalName: "Arta", taxId: "123" })));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(to).toContain("editTax=1&error=Ky nuk duket si numër personal (NID).");
  });

  it("an RPC failure shows our own message and logs the code only", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "set_author_tax_details: nid format is not valid" } });
    const to = await target(() => saveTaxDetails(form({ residence: "albania", legalName: "Arta", taxId: "J12345678A" })));
    expect(to).toContain("Ky nuk duket si numër personal (NID).");
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain("J12345678A");
    expect(logged).not.toContain("Arta");
  });

  it("signed out goes to login", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await target(() => saveTaxDetails(form({})))).toBe("/login?next=/dashboard/payment");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("savePaymentBankAccount", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("saves through set_author_payout_destination with the currency fixed to ALL", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const to = await target(() =>
      savePaymentBankAccount(form({ beneficiaryName: "Arta", iban: "XK05 1212 0123 4567 8906", currency: "EUR" })),
    );
    expect(mockRpc).toHaveBeenCalledWith("set_author_payout_destination", {
      p_currency: "ALL",
      p_beneficiary_name: "Arta",
      p_iban: "XK05 1212 0123 4567 8906",
    });
    expect(to).toBe("/dashboard/payment?success=Të dhënat bankare u ruajtën.");
  });

  it("needs both fields", async () => {
    const to = await target(() => savePaymentBankAccount(form({ beneficiaryName: "Arta" })));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(to).toContain("editBank=1&error=Plotësoni edhe emrin");
  });

  it("maps the foreign-format refusal and never logs the IBAN", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "set_author_payout_destination: iban does not match the expected IBAN format" },
    });
    const to = await target(() => savePaymentBankAccount(form({ beneficiaryName: "Arta", iban: "ZZ12" })));
    expect(to).toContain("Ky IBAN nuk duket i vlefshëm.");
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain("ZZ12");
  });
});
