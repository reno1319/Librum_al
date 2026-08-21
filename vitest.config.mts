import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // route.ts imports the shared `stripe` client (src/lib/stripe.ts) at
      // module scope, which throws immediately if the SDK gets no API key
      // -- even though these tests never make a real Stripe call. A dummy
      // value only needs to satisfy that constructor; it is never sent
      // anywhere.
      STRIPE_SECRET_KEY: "sk_test_dummy_for_vitest",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
});
