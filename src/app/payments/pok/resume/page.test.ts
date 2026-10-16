import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: (target: string) => { throw Object.assign(new Error("redirect"), { target }); } }));
import PokResumePage from "./page";
import { ResumeRedirect } from "./resume-redirect";

const id = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const render = (query: { intent?: string | string[]; token?: string | string[]; extra?: string }) => PokResumePage({ searchParams: Promise.resolve(query) });

describe("POK resume page (R3-ADDR)", () => {
  it("hands over to the return route with only the validated values", async () => {
    const element = await render({ intent: id, token, extra: "x" });
    expect(element.type).toBe(ResumeRedirect);
    expect(element.props).toEqual({ to: `/payments/pok/return?intent=${id}&token=${token}` });
  });

  it.each([
    {},
    { intent: id },
    { token },
    { intent: "not-a-uuid", token },
    { intent: id, token: "/evil" },
    { intent: [id, id], token },
  ])("refuses an invalid hand-over %#", async (query) => {
    await expect(render(query)).rejects.toMatchObject({ target: "/library?error=Invalid+payment+return" });
  });

  // No render harness here (plain node vitest; see route-group-structure.test.ts).
  // The fix depends on a full browser navigation that replaces this page's
  // history entry, so a router push or location.assign would bring the bug back.
  it("navigates with window.location.replace", () => {
    const source = readFileSync(path.join(__dirname, "resume-redirect.tsx"), "utf8");
    expect(source).toMatch(/^"use client";/);
    expect(source).toMatch(/window\.location\.replace\(to\)/);
    expect(source).not.toMatch(/useRouter|location\.assign|location\.href\s*=/);
  });
});
