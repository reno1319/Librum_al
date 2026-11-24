import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { maskIban, PAYOUT_DESTINATION_CURRENCY } from "../balance/balance-logic";
import { getOwnPaymentDetails, savePaymentBankAccount, saveTaxDetails } from "./actions";
import {
  ALBANIA_CODE,
  KOSOVO_CODE,
  PAYMENT_PAGE_PATH,
  WITHHOLDING_PERCENT,
  abroadCountryOptions,
  countryName,
  maskTaxId,
  paymentReadyCount,
} from "./payment-logic";
import { TaxDetailsFields } from "./tax-details-fields";

export const metadata: Metadata = {
  title: "Të dhënat e pagesës",
};

// Reads the maintenance env var on every request, like Bilanci.
export const dynamic = "force-dynamic";

// BUILD 3 (Renato 11-23, pictures r1 approved "p1 a"): the author's tax
// details and bank account, required before a PAID book can be sold.
// Saved numbers are only ever shown hidden (maskTaxId / maskIban); the
// full NID or tax number is never sent back to the browser, so editing
// means typing it again.
export default async function PaymentDetailsPage({
  searchParams,
}: {
  searchParams: Promise<{ editTax?: string; editBank?: string; error?: string; success?: string }>;
}) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { editTax, editBank, error: rawError, success: rawSuccess } = await searchParams;
  const queryError = pageErrorMessage(rawError);
  const querySuccess = pageSuccessMessage(rawSuccess);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${PAYMENT_PAGE_PATH}`);
  }

  const result = await getOwnPaymentDetails();
  if (!result.ok) {
    throw new Error(result.error);
  }
  const { tax, bank } = result;
  const ready = paymentReadyCount({ hasTaxDetails: tax !== null, hasBankAccount: bank !== null });
  const editingTax = tax === null || editTax === "1";
  const editingBank = bank === null || editBank === "1";
  const initialResidence = tax && tax.country_code !== ALBANIA_CODE ? "abroad" : "albania";

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Kthehuni te paneli
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Të dhënat e pagesës"
          description="Kërkohen para se të vini në shitje një libër me çmim. Librat falas nuk i kërkojnë. Këto të dhëna nuk shfaqen askund publikisht."
        />
      </div>

      {queryError && (
        <Alert variant="error" className="mt-4">
          {queryError}
        </Alert>
      )}
      {querySuccess && (
        <Alert variant="success" className="mt-4">
          {querySuccess}
        </Alert>
      )}

      <Alert variant="info" className="mt-4">
        {ready === 2 ? (
          <>
            <strong>2 nga 2 gati.</strong> Mund të vini në shitje libra me çmim.
          </>
        ) : (
          <>
            <strong>{ready} nga 2 gati.</strong> Për librat falas nuk ka nevojë.
          </>
        )}
      </Alert>

      <section className="mt-6 rounded-card border border-border bg-surface p-4 shadow-sm" aria-labelledby="tax-heading">
        <h2 id="tax-heading" className="font-serif text-base font-normal">
          Të dhënat tatimore
        </h2>
        {!editingTax && tax ? (
          <>
            <p className="mt-2 text-sm font-medium text-emerald-700">&#10003; U ruajt</p>
            <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">Emri ligjor</dt>
                <dd className="font-medium">{tax.legal_name}</dd>
              </div>
              <div>
                <dt className="text-muted">Ku paguani tatimet</dt>
                <dd className="font-medium">
                  {tax.country_code === ALBANIA_CODE ? "Në Shqipëri" : countryName(tax.country_code)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">
                  {tax.country_code === ALBANIA_CODE ? "Numri personal (NID)" : "Numri tatimor"}
                </dt>
                <dd className="font-medium">{maskTaxId(tax.tax_id)}</dd>
              </div>
            </dl>
            <Link href={`${PAYMENT_PAGE_PATH}?editTax=1`} className={buttonClasses("outline", "sm", "mt-4")}>
              Ndryshoni të dhënat tatimore
            </Link>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted">
              Mbajmë {WITHHOLDING_PERCENT}% tatim nga honoraret për të gjithë autorët, brenda dhe jashtë Shqipërisë, dhe e
              deklarojmë në emrin tuaj ligjor. Ky emër mund të jetë ndryshe nga emri juaj i autorit.
            </p>
            <form action={saveTaxDetails} className="mt-4 flex flex-col gap-4">
              <TaxDetailsFields
                countries={abroadCountryOptions()}
                initialResidence={initialResidence}
                initialCountryCode={tax && tax.country_code !== ALBANIA_CODE ? tax.country_code : KOSOVO_CODE}
                initialLegalName={tax?.legal_name ?? ""}
              />
              <div className="mt-1 flex flex-wrap gap-3">
                <button type="submit" className={buttonClasses("primary", "md")}>
                  Ruani të dhënat tatimore
                </button>
                {tax && (
                  <Link href={PAYMENT_PAGE_PATH} className={buttonClasses("outline", "md")}>
                    Anuloni
                  </Link>
                )}
              </div>
            </form>
          </>
        )}
      </section>

      <section className="mt-4 rounded-card border border-border bg-surface p-4 shadow-sm" aria-labelledby="bank-heading">
        <h2 id="bank-heading" className="font-serif text-base font-normal">
          Llogaria bankare
        </h2>
        {!editingBank && bank ? (
          <>
            <p className="mt-2 text-sm font-medium text-emerald-700">&#10003; U ruajt</p>
            <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">Mbajtësi i llogarisë</dt>
                <dd className="font-medium">{bank.beneficiary_name}</dd>
              </div>
              <div>
                <dt className="text-muted">IBAN</dt>
                <dd className="font-medium">{maskIban(bank.iban)}</dd>
              </div>
              <div>
                <dt className="text-muted">Monedha</dt>
                <dd className="font-medium">{bank.currency}</dd>
              </div>
            </dl>
            <Link href={`${PAYMENT_PAGE_PATH}?editBank=1`} className={buttonClasses("outline", "sm", "mt-4")}>
              Ndryshoni llogarinë bankare
            </Link>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted">
              {bank
                ? "Ndryshimi i llogarisë bankare vlen vetëm për pagesat e ardhshme. Një pagesë që po përpunohet mban të dhënat bankare që kishte."
                : "Llogaria ku do t'ju dërgojmë honoraret, kur pagesat të aktivizohen."}
            </p>
            <form action={savePaymentBankAccount} className="mt-4 flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm">
                Emri i mbajtësit të llogarisë
                <input
                  name="beneficiaryName"
                  type="text"
                  required
                  autoComplete="off"
                  placeholder="Emri i plotë në llogarinë bankare"
                  className={formControlClasses}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                IBAN
                <input
                  name="iban"
                  type="text"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="AL47 2121 1009 0000 0002 3569 8741"
                  className={formControlClasses}
                />
                <span className="text-sm text-muted">
                  Pranojmë IBAN shqiptar ose të huaj. Kontrollojmë vetëm formatin, jo që llogaria është juaja.
                </span>
              </label>
              <div className="flex flex-col gap-1 text-sm">
                <span>Monedha</span>
                <span className="text-muted">
                  {PAYOUT_DESTINATION_CURRENCY} (lek shqiptar). Nëse llogaria juaj është jashtë Shqipërisë, banka e konverton
                  në monedhën e llogarisë në ditën e pagesës.
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-3">
                <button type="submit" className={buttonClasses("primary", "md")}>
                  Ruani llogarinë bankare
                </button>
                {bank && (
                  <Link href={PAYMENT_PAGE_PATH} className={buttonClasses("outline", "md")}>
                    Anuloni
                  </Link>
                )}
              </div>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
