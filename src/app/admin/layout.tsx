// ADMIN-1A.5 FINAL ROUTING INVARIANT CORRECTION: this file used to be
// where the staff gate lived, with a pathname comparison
// (`pathname === ADMIN_LOGIN_PATH`, read via headers()/
// INTERNAL_PATHNAME_HEADER) carving out an exception for /admin/login so
// it wouldn't gate itself. That runtime exception is gone. The gate now
// lives one level down, in admin/(protected)/layout.tsx, which wraps
// ONLY admin/page.tsx, admin/reports/**, and admin/refunds/** -- every
// "operational" admin surface. admin/login/** sits OUTSIDE that group,
// as a sibling directory, so it structurally never passes through
// admin/(protected)/layout.tsx and never needs an exception carved out
// for it here: there is nothing here to bypass. This file is now purely
// structural glue (Next.js requires SOME layout.tsx to exist at a
// segment with multiple differently-laid-out children directories for
// this file tree to resolve the way it's organized) -- it makes no
// authorization decision, reads no request state, and renders no admin
// chrome of its own. Do not add a pathname check, a requireStaff call,
// or an AdminShell wrap back into this file -- that logic belongs in
// admin/(protected)/layout.tsx now, exactly once.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
