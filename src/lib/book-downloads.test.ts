import { describe, expect, it, vi } from "vitest";
import {
  buyerDownloadNote,
  DOWNLOAD_CANCEL_WARNING,
  formatDownloadTime,
  parseMyDownloadStates,
  parsePurchaseDownloadStates,
  readMyDownloadStates,
  readPurchaseDownloadStates,
  staffAmountLabel,
  staffCancelLabel,
  staffDownloadLabel,
  type PurchaseDownloadState,
} from "./book-downloads";
import { formatTransactionAmount } from "./transaction-money";

const NOW = new Date("2026-10-24T10:00:00Z");
const BOOK = "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a";

function purchase(overrides: Partial<PurchaseDownloadState> = {}): PurchaseDownloadState {
  return {
    purchaseId: "c0ffee00-1234-4abc-9def-0123456789ab",
    bookId: BOOK,
    paymentId: "e0800002-0000-4000-8000-0000000000d1",
    amountMinor: 499,
    currency: "ALL",
    boughtAt: "2026-10-23T10:00:00+00:00",
    refundedAt: null,
    downloadCount: 0,
    firstDownloadedAt: null,
    lastDownloadedAt: null,
    paymentFirstDownloadedAt: null,
    cancelOpenUntil: "2026-11-06T10:00:00+00:00",
    ...overrides,
  };
}

function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: "c0ffee00-1234-4abc-9def-0123456789ab",
    book_id: BOOK,
    payment_id: null,
    amount_minor: 0,
    currency: null,
    bought_at: "2026-10-23T10:00:00+00:00",
    refunded_at: null,
    download_count: 0,
    first_downloaded_at: null,
    last_downloaded_at: null,
    payment_first_downloaded_at: null,
    cancel_open_until: null,
    ...overrides,
  };
}

describe("buyerDownloadNote", () => {
  it("warns while the cancel window is open", () => {
    expect(buyerDownloadNote({ firstDownloadedAt: null, cancelOpenUntil: "2026-11-06T10:00:00Z" }, NOW)).toBe(
      DOWNLOAD_CANCEL_WARNING,
    );
    expect(DOWNLOAD_CANCEL_WARNING).toBe("Shkarkimi i jep fund të drejtës suaj për ta anuluar këtë blerje.");
  });

  it("does not warn once the window has passed, even if the read is stale", () => {
    expect(buyerDownloadNote({ firstDownloadedAt: null, cancelOpenUntil: "2026-10-24T09:59:59Z" }, NOW)).toBeNull();
  });

  it("shows the first download date once downloaded", () => {
    const note = buyerDownloadNote({ firstDownloadedAt: "2026-10-20T12:00:00Z", cancelOpenUntil: null }, NOW);
    expect(note).toMatch(/^Shkarkuar më /);
    expect(note).toContain("2026");
  });

  it("shows nothing for no state or a free book never downloaded", () => {
    expect(buyerDownloadNote(undefined, NOW)).toBeNull();
    expect(buyerDownloadNote({ firstDownloadedAt: null, cancelOpenUntil: null }, NOW)).toBeNull();
  });
});

describe("parseMyDownloadStates", () => {
  it("keeps well-formed rows by book and drops the rest", () => {
    const states = parseMyDownloadStates([
      { book_id: BOOK, first_downloaded_at: null, cancel_open_until: "2026-11-06T10:00:00Z" },
      { book_id: 42, first_downloaded_at: null, cancel_open_until: null },
      { book_id: "other", first_downloaded_at: 7, cancel_open_until: null },
      null,
    ]);
    expect([...states.keys()]).toEqual([BOOK]);
    expect(states.get(BOOK)).toEqual({ firstDownloadedAt: null, cancelOpenUntil: "2026-11-06T10:00:00Z" });
    expect(parseMyDownloadStates(null).size).toBe(0);
  });
});

describe("readMyDownloadStates", () => {
  it("calls the caller-scoped function with no arguments", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: [], error: null }));
    await readMyDownloadStates({ rpc } as never);
    expect(rpc).toHaveBeenCalledWith("my_purchase_download_states");
  });

  it("a failed read gives no lines, logging the code only", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { code: "42501", message: "secret detail" } }));
    const states = await readMyDownloadStates({ rpc } as never);
    expect(states.size).toBe(0);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret detail");
    errorSpy.mockRestore();
  });
});

describe("parsePurchaseDownloadStates / readPurchaseDownloadStates", () => {
  it("parses rows newest first", () => {
    const rows = parsePurchaseDownloadStates([
      rawRow({ purchase_id: "a", bought_at: "2026-10-01T00:00:00+00:00" }),
      rawRow({ purchase_id: "b", bought_at: "2026-10-20T00:00:00+00:00", payment_id: "p", currency: "ALL", amount_minor: 499 }),
    ]);
    expect(rows?.map((r) => r.purchaseId)).toEqual(["b", "a"]);
    expect(rows?.[0]).toMatchObject({ paymentId: "p", currency: "ALL", amountMinor: 499 });
  });

  it("rejects the whole read on any malformed row (no partial picture)", () => {
    expect(parsePurchaseDownloadStates([rawRow(), rawRow({ download_count: "1" })])).toBeNull();
    expect(parsePurchaseDownloadStates([rawRow({ cancel_open_until: 5 })])).toBeNull();
    expect(parsePurchaseDownloadStates([rawRow({ payment_id: undefined })])).toBeNull();
    expect(parsePurchaseDownloadStates({})).toBeNull();
  });

  it("asks for exactly the given account and fails to null on error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(() => Promise.resolve({ data: [rawRow()], error: null }));
    expect(await readPurchaseDownloadStates({ rpc } as never, "user-1")).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("purchase_download_states", { p_reader_id: "user-1" });
    const failing = vi.fn(() => Promise.resolve({ data: null, error: { code: "XX000" } }));
    expect(await readPurchaseDownloadStates({ rpc: failing } as never, "user-1")).toBeNull();
    errorSpy.mockRestore();
  });
});

describe("staff labels", () => {
  it("formats download times in Tirana time", () => {
    // 10:00 UTC is 12:00 in Tirana in October (CEST, before 25 Oct).
    expect(formatDownloadTime("2026-10-24T10:00:00Z")).toBe("24 Oct 2026, 12:00 (Tirana time)");
  });

  it("cancel: open, downloaded, bundle sibling downloaded, past, refunded, free", () => {
    expect(staffCancelLabel(purchase(), NOW)).toMatch(/^Can cancel until 6 Nov 2026/);
    expect(
      staffCancelLabel(purchase({ cancelOpenUntil: null, firstDownloadedAt: "2026-10-23T11:00:00Z", downloadCount: 1 }), NOW),
    ).toBe("Can't cancel: downloaded");
    expect(
      staffCancelLabel(purchase({ cancelOpenUntil: null, paymentFirstDownloadedAt: "2026-10-23T11:00:00Z" }), NOW),
    ).toBe("Can't cancel: another book in the same order was downloaded");
    expect(staffCancelLabel(purchase({ cancelOpenUntil: null }), NOW)).toBe(
      "Can't cancel: more than 14 days, or the payment isn't complete",
    );
    expect(staffCancelLabel(purchase({ cancelOpenUntil: "2026-10-24T09:00:00Z" }), NOW)).toBe(
      "Can't cancel: more than 14 days, or the payment isn't complete",
    );
    expect(staffCancelLabel(purchase({ refundedAt: "2026-10-23T12:00:00Z" }), NOW)).toBe("Refunded");
    expect(staffCancelLabel(purchase({ paymentId: null, cancelOpenUntil: null }), NOW)).toBe(
      "Free or older order: no 14-day cancel",
    );
  });

  it("downloads: none, one, several", () => {
    expect(staffDownloadLabel(purchase())).toBe("Not downloaded");
    expect(staffDownloadLabel(purchase({ downloadCount: 1, firstDownloadedAt: "2026-10-24T10:00:00Z" }))).toBe(
      "First downloaded 24 Oct 2026, 12:00 (Tirana time)",
    );
    expect(
      staffDownloadLabel(
        purchase({ downloadCount: 3, firstDownloadedAt: "2026-10-24T10:00:00Z", lastDownloadedAt: "2026-10-24T11:00:00Z" }),
      ),
    ).toBe("First downloaded 24 Oct 2026, 12:00 (Tirana time); 3 downloads, last 24 Oct 2026, 13:00 (Tirana time)");
  });

  it("amounts: paid, free, older order without a currency", () => {
    expect(staffAmountLabel(purchase({ amountMinor: 49900 }))).toBe(formatTransactionAmount(49900, { state: "resolved", currency: "ALL" }));
    expect(staffAmountLabel(purchase({ paymentId: null, amountMinor: 0, currency: null }))).toBe("Falas");
    expect(staffAmountLabel(purchase({ paymentId: null, amountMinor: 999, currency: null }))).toBe(
      "Shuma nuk është e disponueshme (monedhë e panjohur)",
    );
  });
});
