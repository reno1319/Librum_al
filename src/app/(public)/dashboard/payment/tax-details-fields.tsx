"use client";

import { useState } from "react";
import { formControlClasses } from "@/lib/form-styles";
import type { CountryOption } from "./payment-logic";

// BUILD 3: the "Ku paguani tatimet?" choice. "Në Shqipëri" asks for the
// NID; "Jashtë Shqipërisë" asks for the country and the home tax number
// (t2 a). Only the chosen set of fields is in the form, so the server
// never receives both.
export function TaxDetailsFields({
  countries,
  initialResidence,
  initialCountryCode,
  initialLegalName,
}: {
  countries: CountryOption[];
  initialResidence: "albania" | "abroad";
  initialCountryCode: string;
  initialLegalName: string;
}) {
  const [residence, setResidence] = useState<"albania" | "abroad">(initialResidence);

  return (
    <>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1">Ku paguani tatimet mbi të ardhurat?</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="residence"
            value="albania"
            checked={residence === "albania"}
            onChange={() => setResidence("albania")}
          />
          Në Shqipëri
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="residence"
            value="abroad"
            checked={residence === "abroad"}
            onChange={() => setResidence("abroad")}
          />
          Jashtë Shqipërisë
        </label>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        Emri i plotë ligjor
        <input
          name="legalName"
          type="text"
          required
          maxLength={200}
          autoComplete="off"
          defaultValue={initialLegalName}
          placeholder="Si në kartën e identitetit"
          className={formControlClasses}
        />
      </label>

      {residence === "albania" ? (
        <label key="nid" className="flex flex-col gap-1 text-sm">
          Numri personal (NID)
          <input
            name="taxId"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="J12345678A"
            className={formControlClasses}
          />
          <span className="text-sm text-muted">Numri personal në kartën e identitetit (10 shenja).</span>
        </label>
      ) : (
        <>
          <label key="country" className="flex flex-col gap-1 text-sm">
            Shteti
            <select name="countryCode" required defaultValue={initialCountryCode} className={formControlClasses}>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </label>
          <label key="tin" className="flex flex-col gap-1 text-sm">
            Numri tatimor në shtetin tuaj
            <input
              name="taxId"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              className={formControlClasses}
            />
            <span className="text-sm text-muted">
              Numri me të cilin ju njeh zyra e tatimeve në shtetin tuaj. Në Kosovë është numri personal në letërnjoftim.
            </span>
          </label>
        </>
      )}
    </>
  );
}
