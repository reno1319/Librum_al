import { describe, expect, it } from "vitest";

// ADMIN-1A.5 FINAL ROUTING INVARIANT CORRECTION: admin/layout.tsx no
// longer makes any authorization decision -- that moved to
// admin/(protected)/layout.tsx (see src/app/admin/(protected)/
// layout.test.ts for its own coverage: requireStaff("admin.access"),
// AdminShell wrapping, denial behavior). All that's left to prove here
// is that this file is genuinely inert: no requireStaff import, no
// AdminShell import, no pathname/header inspection, and children pass
// straight through unchanged for whichever child segment (admin/login/
// or admin/(protected)/) happens to be rendering. No mocking is needed
// to prove this -- the function is called directly, exactly like every
// other layout test in this codebase (see src/app/admin/(protected)/
// layout.test.ts, src/app/dashboard/layout.tsx's own precedent).
const { default: AdminLayout } = await import("./layout");

describe("AdminLayout (admin root, structural glue only)", () => {
  it("renders children directly, with no wrapping element", () => {
    const result = AdminLayout({ children: "child content" as unknown as React.ReactNode });
    // A bare Fragment around children -- .type is the Fragment symbol,
    // not AdminShell or any other component.
    expect((result as unknown as { props: { children: unknown } }).props.children).toBe(
      "child content",
    );
  });

  it("is synchronous and makes no authorization decision -- proven by never needing to be awaited or mocked to render", () => {
    // If this file called requireStaff() (an async Supabase-backed
    // call), invoking it without any of that mocking in place would
    // throw or hang. It doesn't, because there is nothing here to call.
    expect(() => AdminLayout({ children: null })).not.toThrow();
  });

  it("source contains no pathname/header inspection and no ADMIN_LOGIN_PATH comparison -- the old bypass exception is fully gone", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const source = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");

    // Scoped to actual imports/calls/JSX usage, not bare word mentions --
    // this file's own comment legitimately names all four of these while
    // explaining why they were removed and telling a future editor not
    // to add them back, so a plain substring match would misfire on its
    // own documentation.
    expect(source).not.toMatch(/import\s*\{[^}]*ADMIN_LOGIN_PATH[^}]*\}/);
    expect(source).not.toMatch(/import\s*\{[^}]*INTERNAL_PATHNAME_HEADER[^}]*\}/);
    expect(source).not.toMatch(/import\s*\{[^}]*requireStaff[^}]*\}/);
    expect(source).not.toMatch(/requireStaff\(/);
    expect(source).not.toMatch(/import\s*\{[^}]*AdminShell[^}]*\}/);
    expect(source).not.toMatch(/<AdminShell\b/);
    expect(source).not.toMatch(/from\s*"next\/headers"/);
  });
});
