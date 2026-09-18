// ALL-CUTOVER APP-A: test-only resolution target for the bare
// "server-only" import, aliased in vitest.config.mts's own
// resolve.alias. Vitest runs under Node with no "react-server"
// condition, so the real server-only package (node_modules/server-
// only) resolves to its default export, index.js, which unconditionally
// throws -- by design, to catch a client-bundle import at build time.
// This file exists ONLY to let Vitest's own module graph load; it is
// never referenced by next.config.ts, never part of the Next.js
// production or dev build, and never changes what src/lib/maintenance-
// mode.ts's or src/lib/maintenance-response.ts's own `import
// "server-only"` resolves to outside a Vitest run. Deliberately empty,
// mirroring the real package's own react-server-condition export
// (node_modules/server-only/empty.js, itself a zero-byte file).
