import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// ALL-TXN-CURRENCY-4 (Patch 4): a source-level guard over every surface
// that displays a TRANSACTION amount -- a purchase, sale, balance,
// payout, finance row, refund, or transactional email. Each must format
// through src/lib/transaction-money.ts with an explicit currency, and
// none may reintroduce a bare `$`, the catalog `formatPrice`, or a
// locale-dependent `Intl.NumberFormat`. The rendered tests next to each
// page prove the output; this file keeps a future edit from quietly
// bringing the old formatting back on a surface without one.
//
// Bundle CATALOG prices (bundle pages, bookstore and author rails) are
// deliberately not listed: they are Patch 5's scope.
const ROOT = path.resolve(__dirname, "..", "..");

const TRANSACTION_SURFACES = [
  "src/app/(public)/account/purchases/page.tsx",
  "src/app/(public)/library/refund-logic.ts",
  "src/app/(public)/dashboard/sales/page.tsx",
  "src/app/(public)/dashboard/sales/revenue-logic.ts",
  "src/app/(public)/dashboard/balance/page.tsx",
  "src/app/(public)/dashboard/balance/balance-logic.ts",
  "src/app/(public)/books/[id]/page.tsx",
  "src/app/admin/(protected)/finance/page.tsx",
  "src/app/admin/(protected)/refunds/page.tsx",
  "src/app/admin/(protected)/refunds/[id]/page.tsx",
  "src/app/admin/(protected)/refunds/[id]/issue-refund-button.tsx",
  "src/app/admin/(protected)/refunds/refund-review-logic.ts",
  "src/lib/email.ts",
];

// Comments may legitimately explain what was removed ("never a bare
// '$'"), so only code is checked.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("transaction surfaces: currency-aware formatting only (Patch 4)", () => {
  for (const relativePath of TRANSACTION_SURFACES) {
    describe(relativePath, () => {
      const code = stripComments(readFileSync(path.join(ROOT, relativePath), "utf8"));

      it("formats through transaction-money", () => {
        // The balance page reaches it through balance-logic's
        // formatMinorAmount, which delegates to formatTransactionAmount.
        const direct = /from "@\/lib\/transaction-money"/.test(code);
        const viaBalanceLogic =
          relativePath.endsWith("balance/page.tsx") && /formatMinorAmount,[\s\S]*from "\.\/balance-logic"/.test(code);
        expect(direct || viaBalanceLogic).toBe(true);
      });

      it("has no bare dollar sign in front of an amount", () => {
        expect(code).not.toMatch(/\$\$\{/); // `$${...}` in a template
        if (relativePath.endsWith(".tsx")) {
          // In JSX, `>${amount}` is a literal "$" before an expression. (In
          // a .ts template literal the same characters are interpolation.)
          expect(code).not.toMatch(/>\s*\$\s*\{/);
        }
        expect(code).not.toMatch(/["'`]\$["'`]/); // a literal "$"
        expect(code).not.toMatch(/\$\d/); // a hard-coded "$5"
      });

      it("never uses the catalog or locale-dependent money formatters", () => {
        expect(code).not.toMatch(/\bformatPrice\(/);
        expect(code).not.toMatch(/\bformatAllPrice\(/);
        expect(code).not.toContain("Intl.NumberFormat");
        expect(code).not.toMatch(/\/\s*100\)\.toFixed\(2\)/);
      });
    });
  }
});
