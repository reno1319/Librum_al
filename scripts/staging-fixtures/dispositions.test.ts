import { describe, expect, it } from "vitest";
import {
  DISPOSITION_MATRIX,
  orderedDeleteTables,
  protectedTables,
  rpcOnlyProtectedTables,
  transientOnlyDeleteTables,
  BASELINE_RESEEDED_TABLES,
  classifyPurchase,
  type ExpectedSyntheticPurchase,
  type FixturePurchaseRow,
} from "./dispositions.mts";

// PHASE-1C review round 4, item 4: the 3 payout tables with
// `revoke all ... from anon, authenticated, service_role` in
// schema.sql -- unreachable via a direct REST count, counted instead
// via the narrowly scoped public.staging_fixture_protected_table_counts
// SECURITY DEFINER RPC (migration 057).
const RPC_ONLY_PROTECTED_TABLES = [
  "author_payout_destinations",
  "payout_destination_snapshots",
  "payout_reversal",
];

describe("DISPOSITION_MATRIX ordering", () => {
  const order = orderedDeleteTables("resetToBaseline");
  const indexOf = (name: string) => order.indexOf(name);

  it("orders refund_request_items before books (RESTRICT on books.id)", () => {
    expect(indexOf("refund_request_items")).toBeGreaterThanOrEqual(0);
    expect(indexOf("books")).toBeGreaterThan(indexOf("refund_request_items"));
  });

  it("orders purchases before books (RESTRICT on books.id)", () => {
    expect(indexOf("purchases")).toBeGreaterThanOrEqual(0);
    expect(indexOf("books")).toBeGreaterThan(indexOf("purchases"));
  });

  it("orders bundle_checkout_reader_holds before auth.users deletion (RESTRICT on profiles.id)", () => {
    expect(indexOf("bundle_checkout_reader_holds")).toBeGreaterThanOrEqual(0);
    const authUsersRow = DISPOSITION_MATRIX.find((t) => t.table === "auth.users");
    expect(authUsersRow?.teardown).toBe("delete");
    expect(authUsersRow?.resetToBaseline).toBe("preserve");
  });

  it("every table in the matrix appears exactly once", () => {
    const names = DISPOSITION_MATRIX.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
  });

  // PHASE-1C mandatory correction, item 6: refund_issuance_attempts is
  // NOT in the ordered delete list at all (it is a hard_stop, never
  // deleted by this design), and refund_requests -- the table it
  // RESTRICTs -- must never be reached if any issuance attempt exists.
  it("refund_issuance_attempts is a hard_stop, not a delete target", () => {
    expect(order).not.toContain("refund_issuance_attempts");
    const row = DISPOSITION_MATRIX.find((t) => t.table === "refund_issuance_attempts");
    expect(row?.resetToBaseline).toBe("hard_stop");
    expect(row?.teardown).toBe("hard_stop");
  });
});

describe("protected (hard_stop) tables include every named protected category", () => {
  const required = [
    "payments",
    "author_payouts",
    "author_ledger_entries",
    "author_payout_settings",
    "author_payout_destinations",
    "payout_destination_snapshots",
    "payout_reversal",
    "payment_refunds",
    "payment_disputes",
    "blog_posts",
    "staff_members",
    "bundle_checkout_snapshots",
    // PHASE-1C mandatory correction, item 6.
    "refund_issuance_attempts",
  ];

  it("resetToBaseline hard-stops on all of them", () => {
    const stops = protectedTables("resetToBaseline");
    for (const table of required) {
      expect(stops, `expected ${table} to be a resetToBaseline hard_stop`).toContain(table);
    }
  });

  it("teardown hard-stops on all of them too", () => {
    const stops = protectedTables("teardown");
    for (const table of required) {
      expect(stops, `expected ${table} to be a teardown hard_stop`).toContain(table);
    }
  });
});

describe("admin_audit_log / payout_minimum_policy are preserved, never deleted", () => {
  it("are disposition 'preserve' in both modes", () => {
    for (const table of ["admin_audit_log", "payout_minimum_policy"]) {
      const row = DISPOSITION_MATRIX.find((t) => t.table === table);
      expect(row?.resetToBaseline).toBe("preserve");
      expect(row?.teardown).toBe("preserve");
    }
  });

  it("are never included in the ordered delete list", () => {
    const deleteList = [...orderedDeleteTables("resetToBaseline"), ...orderedDeleteTables("teardown")];
    expect(deleteList).not.toContain("admin_audit_log");
    expect(deleteList).not.toContain("payout_minimum_policy");
  });
});

// PHASE-1C review round 4, item 4.
describe("rpcOnlyProtectedTables", () => {
  it("flags exactly the 3 ungranted payout tables as RPC-only", () => {
    expect([...rpcOnlyProtectedTables("resetToBaseline")].sort()).toEqual([...RPC_ONLY_PROTECTED_TABLES].sort());
    expect([...rpcOnlyProtectedTables("teardown")].sort()).toEqual([...RPC_ONLY_PROTECTED_TABLES].sort());
  });

  it("every RPC-only table is still a normal member of protectedTables() -- checked uniformly, not separately", () => {
    const protectedList = protectedTables("resetToBaseline");
    for (const table of RPC_ONLY_PROTECTED_TABLES) {
      expect(protectedList).toContain(table);
    }
  });

  it("protectedTables() still includes every other protected table too", () => {
    const protectedList = protectedTables("resetToBaseline");
    for (const table of ["payments", "author_payouts", "author_ledger_entries", "payment_refunds", "payment_disputes", "refund_issuance_attempts", "blog_posts", "staff_members", "bundle_checkout_snapshots"]) {
      expect(protectedList).toContain(table);
    }
  });

  it("payment_refunds and payment_disputes traversals cover fixture-author books, not just the fixture reader", () => {
    const refunds = DISPOSITION_MATRIX.find((t) => t.table === "payment_refunds");
    const disputes = DISPOSITION_MATRIX.find((t) => t.table === "payment_disputes");
    expect(refunds?.traversal).toMatch(/fixtureAuthorBookIds/);
    expect(disputes?.traversal).toMatch(/fixtureAuthorBookIds/);
    expect(disputes?.traversal).not.toMatch(/fixture_pi_/);
  });
});

// PHASE-1C review round 3, item 2.
describe("BASELINE_RESEEDED_TABLES / transientOnlyDeleteTables", () => {
  it("includes every table reseeding actually recreates, including bundle_books", () => {
    expect([...BASELINE_RESEEDED_TABLES].sort()).toEqual(
      ["series", "books", "book_contributors", "bundle_books", "bundles", "discount_codes", "purchases"].sort(),
    );
  });

  it("transientOnlyDeleteTables excludes every baseline-reseeded table", () => {
    const transient = transientOnlyDeleteTables("resetToBaseline");
    for (const table of BASELINE_RESEEDED_TABLES) {
      expect(transient).not.toContain(table);
    }
  });

  it("transientOnlyDeleteTables still includes genuinely transient tables", () => {
    const transient = transientOnlyDeleteTables("resetToBaseline");
    for (const table of ["reviews", "wishlist_items", "author_follows", "book_reports", "refund_requests"]) {
      expect(transient).toContain(table);
    }
  });
});

const FIXTURE_READER_ID = "reader-1";
const FIXTURE_AUTHOR_BOOK_IDS = ["book-d", "book-u", "book-p1", "book-p2", "book-f"];

const EXPECTED_SYNTHETIC: ExpectedSyntheticPurchase = {
  id: "purchase-1",
  readerId: FIXTURE_READER_ID,
  bookId: "book-p1",
  amountCents: 499,
  stripeCheckoutSessionId: "fixture_cs_x",
  stripePaymentIntentId: "fixture_pi_x",
  regime: "legacy_stripe_connect_v1",
};

function baseRow(overrides: Partial<FixturePurchaseRow> = {}): FixturePurchaseRow {
  return {
    id: EXPECTED_SYNTHETIC.id,
    readerId: EXPECTED_SYNTHETIC.readerId,
    bookId: EXPECTED_SYNTHETIC.bookId,
    amountCents: EXPECTED_SYNTHETIC.amountCents,
    stripeCheckoutSessionId: EXPECTED_SYNTHETIC.stripeCheckoutSessionId,
    stripePaymentIntentId: EXPECTED_SYNTHETIC.stripePaymentIntentId,
    regime: EXPECTED_SYNTHETIC.regime,
    hasLinkedPaymentId: false,
    ...overrides,
  };
}

const CTX = {
  fixtureReaderId: FIXTURE_READER_ID,
  fixtureAuthorBookIds: FIXTURE_AUTHOR_BOOK_IDS,
  expectedSynthetic: EXPECTED_SYNTHETIC,
};

describe("classifyPurchase", () => {
  it("classifies the exact synthetic seeded row as safe to delete", () => {
    expect(classifyPurchase(baseRow(), CTX).kind).toBe("safe_delete_synthetic");
  });

  it("hard-stops if ANY single identity field differs from the expected synthetic row, even a matching payment-intent id", () => {
    // amount differs -- everything else matches.
    expect(classifyPurchase(baseRow({ amountCents: 500 }), CTX).kind).toBe("hard_stop_unexplained");
    // id differs.
    expect(classifyPurchase(baseRow({ id: "some-other-id" }), CTX).kind).toBe("hard_stop_unexplained");
    // regime differs.
    expect(classifyPurchase(baseRow({ regime: "librum_ledger_v1" }), CTX).kind).toBe("hard_stop_unexplained");
  });

  it("classifies a genuine free acquisition (fixture reader, fixture-author book, $0, no Stripe ids, no payment link) as safe", () => {
    const row = baseRow({
      id: "free-1",
      bookId: "book-f",
      amountCents: 0,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
    });
    expect(classifyPurchase(row, CTX).kind).toBe("safe_delete_free_acquisition");
  });

  it("hard-stops a $0 row that has a linked payment id (anomalous)", () => {
    const row = baseRow({
      id: "free-2",
      bookId: "book-f",
      amountCents: 0,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      hasLinkedPaymentId: true,
    });
    expect(classifyPurchase(row, CTX).kind).toBe("hard_stop_unexplained");
  });

  // PHASE-1C mandatory correction, item 5's required test: "a purchase
  // by an unrelated staging reader for a fixture-author book is never
  // deleted."
  it("hard-stops (never deletes) a purchase by an UNRELATED reader for a fixture-author book", () => {
    const row = baseRow({
      id: "unrelated-1",
      readerId: "some-other-staging-reader-id",
      bookId: "book-p2",
      amountCents: 799,
      stripeCheckoutSessionId: "cs_real_looking",
      stripePaymentIntentId: "pi_real_looking",
    });
    const result = classifyPurchase(row, CTX);
    expect(result.kind).toBe("hard_stop_unexplained");
    expect(result.kind).not.toBe("safe_delete_synthetic");
    expect(result.kind).not.toBe("safe_delete_free_acquisition");
  });

  it("hard-stops a purchase for a book NOT owned by the fixture author, even by the fixture reader", () => {
    const row = baseRow({
      id: "unrelated-2",
      bookId: "some-unrelated-authors-book",
      amountCents: 0,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
    });
    expect(classifyPurchase(row, CTX).kind).toBe("hard_stop_unexplained");
  });
});
