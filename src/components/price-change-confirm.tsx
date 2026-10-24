"use client";

import { useEffect, useRef, useState } from "react";
import { parseCatalogPriceAll } from "@/lib/catalog-price";
import { PRICE_CHANGE_CONFIRM_FIELD, priceChangeConfirmText } from "@/lib/price-change-confirm";

// LIVE-PRICE-CONFIRM-1: the tick under a LIVE book's or bundle's price.
// Placed inside the same form as the price field (name="price"), which
// it watches; the field's own markup is not touched. It appears only
// while the typed price parses to a value different from the saved one,
// and its value is that new price, which the Server Action checks
// (src/lib/price-change-confirm.ts). `required`, so the browser stops
// the save until it is ticked; the server refuses it again without.
//
// The form-draft keeper writes a restored price without an input event,
// so the field is also read once after mount, a tick later.
export function PriceChangeConfirm({ currentPriceAll }: { currentPriceAll: number | null }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [newPriceAll, setNewPriceAll] = useState<number | null>(null);

  useEffect(() => {
    const field = anchor.current?.closest("form")?.elements.namedItem("price");
    if (!(field instanceof HTMLInputElement)) return;

    const read = () => {
      const parsed = parseCatalogPriceAll(field.value);
      setNewPriceAll(parsed.ok && parsed.priceAll !== currentPriceAll ? parsed.priceAll : null);
    };
    const timer = window.setTimeout(read, 0);
    field.addEventListener("input", read);
    return () => {
      window.clearTimeout(timer);
      field.removeEventListener("input", read);
    };
  }, [currentPriceAll]);

  return (
    <div ref={anchor}>
      {newPriceAll !== null && (
        // Keyed by the new price, so a tick given for one price is
        // cleared when the price is changed again.
        <div key={newPriceAll} className="mt-3 flex items-start gap-2 rounded-card border border-border bg-surface p-3 text-sm">
          <input
            id={PRICE_CHANGE_CONFIRM_FIELD}
            name={PRICE_CHANGE_CONFIRM_FIELD}
            type="checkbox"
            value={String(newPriceAll)}
            required
            className="focus-ring mt-1 size-4"
          />
          <label htmlFor={PRICE_CHANGE_CONFIRM_FIELD}>
            {priceChangeConfirmText(currentPriceAll, newPriceAll)}
          </label>
        </div>
      )}
    </div>
  );
}
