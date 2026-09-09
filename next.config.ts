import type { NextConfig } from "next";
import { assertSupabaseEnvSafeForExecution } from "@/lib/supabase/env-guard";

// AUTH-STAGE-1A: this file is loaded once, in Node, by the `next`
// CLI itself -- for `next dev`, `next build`, and `next start` alike --
// and is never bundled into anything shipped to the browser. Running
// the guard here, at config-load time, is what actually protects
// client.ts's browser Supabase client: NEXT_PUBLIC_SUPABASE_URL gets
// inlined into the browser bundle at build time, so refusing to let
// `next build` (or `next dev`'s dev server) start at all with a
// disallowed project ref is the only point that can stop a bad URL
// from ever being baked into a bundle a browser receives -- checking
// inside client.ts itself would be too late (the bundle would already
// exist) and, worse, unreliable (VERCEL_ENV is never inlined into
// browser-bundled code, only NEXT_PUBLIC_-prefixed variables are; see
// env-guard.ts's own top-of-file comment for why that path is
// deliberately left unguarded at the browser-runtime level).
//
// This also covers Phase 1's "local builds must reject the production
// ref" requirement even when no route touches Supabase at build time:
// a plain `npm run build` run locally has VERCEL_ENV unset regardless
// of NODE_ENV, so this throws immediately if .env.local still points
// at the production project.
assertSupabaseEnvSafeForExecution();

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Book uploads (cover + EPUB) can be up to ~55MB combined —
      // see MAX_COVER_BYTES / MAX_MANUSCRIPT_BYTES in
      // src/app/dashboard/books/actions.ts.
      bodySizeLimit: "60mb",
    },
    // src/proxy.ts runs on nearly every request (session refresh), and
    // Next.js buffers the full request body for it up to this limit
    // (default 10MB) before the Server Action ever sees it — anything
    // over gets silently truncated, corrupting the multipart upload.
    proxyClientMaxBodySize: "60mb",
  },
};

export default nextConfig;
