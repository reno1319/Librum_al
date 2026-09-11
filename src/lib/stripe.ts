import Stripe from "stripe";

// PHASE-1C Preview-build correction: constructing this at module scope
// (`export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)`)
// meant merely IMPORTING this file threw whenever STRIPE_SECRET_KEY was
// absent -- and Next.js's build-time "Collecting page data" step
// imports every route module (to gather its config) regardless of
// whether that route is ever visited, so an unconfigured key broke the
// entire `next build`, not just the Stripe-touching routes. A Preview
// deployment for Phase 2 non-payment QA, which deliberately leaves
// Stripe unconfigured, could never build at all.
//
// getStripe() defers both the env read and client construction to the
// first real call, made from inside a request handler/Server Action --
// never from module scope -- so importing this file is always safe,
// and only code paths that actually need Stripe ever require the key.
let cachedClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  cachedClient = new Stripe(apiKey);
  return cachedClient;
}
