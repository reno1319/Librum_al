// LIBRUM 2.0 AUTH-2: the name of the internal request header
// src/lib/supabase/middleware.ts forwards the current request's
// pathname on, for dashboard/layout.tsx to read via headers(). A tiny,
// dependency-free module deliberately separate from middleware.ts
// itself, so a Server Component reading this constant doesn't pull in
// that file's own @supabase/ssr / next/server machinery just to get a
// string.
export const INTERNAL_PATHNAME_HEADER = "x-librum-pathname";
