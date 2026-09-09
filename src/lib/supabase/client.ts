import { createBrowserClient } from "@supabase/ssr";

// AUTH-STAGE-1A: no project-ref guard call here, deliberately. This
// function is bundled into browser JavaScript, and NEXT_PUBLIC_SUPABASE_URL
// is already baked into that bundle at build time. The actual
// enforcement point for this path is next.config.ts, which runs the
// same check in Node before `next build`/`next dev` ever produces or
// serves a bundle -- see that file's comment, and env-guard.ts's
// top-of-file comment, for why checking again here would be both too
// late and unreliable (VERCEL_ENV is never available in browser code).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
