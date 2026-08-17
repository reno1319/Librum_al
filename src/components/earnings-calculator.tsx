"use client";

import { useState } from "react";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";

export function EarningsCalculator() {
  const [price, setPrice] = useState("9.99");
  const priceNum = Number(price);
  const valid = Number.isFinite(priceNum) && priceNum >= 0;
  const feeAmount = valid ? (priceNum * PLATFORM_FEE_PERCENT) / 100 : 0;
  const earnings = valid ? priceNum - feeAmount : 0;

  return (
    <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
      <label className="flex flex-col gap-1 text-sm">
        Your book&apos;s price (USD)
        <input
          type="number"
          min="0"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="w-40 rounded-lg border border-border bg-surface px-3 py-2"
        />
      </label>

      <div
        className="mt-6 flex flex-wrap"
        style={{ gap: "2rem" }}
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">
            Reader pays
          </p>
          <p className="font-serif text-2xl font-semibold">
            ${valid ? priceNum.toFixed(2) : "0.00"}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">
            Platform fee ({PLATFORM_FEE_PERCENT}%)
          </p>
          <p className="font-serif text-2xl font-semibold text-muted">
            -${feeAmount.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">
            You earn
          </p>
          <p className="font-serif text-2xl font-semibold text-primary">
            ${earnings.toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
}
