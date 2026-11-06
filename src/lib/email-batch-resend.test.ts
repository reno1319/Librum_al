import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BD16 P5 r3 (audit G1, G2): sendEmailBatch against the REAL resend SDK
// (resend@6), with only fetch stubbed. resend never throws: a dropped
// connection or a 5xx comes back as { error }, like a refusal. Only a
// refusal status may be reported as "surely not sent"; anything else is
// an unknown outcome and must not be retried. All addresses are made up.

process.env.RESEND_API_KEY = "re_test_dummy_key";
const { sendEmailBatch, isDefiniteRefusal } = await import("./email");

const messages = (n: number) =>
  Array.from({ length: n }, (_v, i) => ({ to: `r${i}@example.test`, subject: "S", html: "H" }));

type Answer = () => Promise<Response>;
let answer: Answer;
const requests: { headers: Headers; body: unknown }[] = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return answer();
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("sendEmailBatch with the real Resend SDK", () => {
  it("a sent batch: nothing to retry", async () => {
    answer = json(200, { data: [{ id: "e0" }, { id: "e1" }] });
    expect(await sendEmailBatch(messages(2), { pauseMs: 0 })).toEqual({ notSent: [], invalid: [] });
  });

  it("G1: a rejected fetch (connection dropped, maybe after Resend accepted it) is unknown, never 'not sent'", async () => {
    answer = async () => {
      throw new TypeError("socket hang up");
    };
    expect(await sendEmailBatch(messages(2), { pauseMs: 0 })).toEqual({ notSent: [], invalid: [] });
  });

  it.each([502, 500, 503, 504])("G1: a %s (HTML or JSON body) is unknown, never 'not sent'", async (status) => {
    answer = async () => new Response("<html>Bad gateway</html>", { status });
    expect((await sendEmailBatch(messages(2), { pauseMs: 0 })).notSent).toEqual([]);
    answer = json(status, { statusCode: status, name: "internal_server_error", message: "x" });
    expect((await sendEmailBatch(messages(2), { pauseMs: 0 })).notSent).toEqual([]);
  });

  it.each([429, 422, 401, 403, 400])("a %s refusal is reported: every email of that batch surely not sent", async (status) => {
    answer = json(status, { statusCode: status, name: "rate_limit_exceeded", message: "for r0@example.test" });
    expect(await sendEmailBatch(messages(3), { pauseMs: 0 })).toEqual({ notSent: [0, 1, 2], invalid: [] });
    // Our own log never repeats Resend's message (which can name an
    // address). The SDK's own "[Resend API Error]" line is printed only
    // outside NODE_ENV=production and is not ours.
    const ours = vi.mocked(console.error).mock.calls.filter((c) => c[0] !== "[Resend API Error]:");
    expect(ours).toHaveLength(1);
    expect(JSON.stringify(ours)).not.toContain("r0@example.test");
  });

  it("G2: permissive validation sends the header and reports the refused addresses as invalid (permanent)", async () => {
    answer = json(200, { data: [{ id: "e0" }, { id: "e2" }], errors: [{ index: 1, message: "Invalid `to` field" }] });
    expect(await sendEmailBatch(messages(3), { pauseMs: 0, permissive: true })).toEqual({ notSent: [], invalid: [1] });
    expect(requests[0].headers.get("x-batch-validation")).toBe("permissive");
  });

  it("strict stays the default for other callers (the followers email)", async () => {
    answer = json(200, { data: [{ id: "e0" }] });
    await sendEmailBatch(messages(1), { pauseMs: 0 });
    expect(requests[0].headers.get("x-batch-validation")).toBe("strict");
  });

  it("indexes count across batches; a junk index is ignored", async () => {
    let call = 0;
    answer = async () => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ data: [], errors: [{ index: 5 }, { index: 999 }, { index: "x" }] }), { status: 200 })
        : call === 2
          ? new Response(JSON.stringify({ data: [], errors: [{ index: 0 }] }), { status: 200 })
          : new Response(JSON.stringify({ statusCode: 429, name: "daily_quota_exceeded", message: "q" }), { status: 429 });
    };
    const result = await sendEmailBatch(messages(201), { pauseMs: 0, permissive: true });
    expect(result).toEqual({ notSent: [200], invalid: [5, 100] });
  });

  it("isDefiniteRefusal: only 400/401/403/422/429", () => {
    for (const s of [400, 401, 403, 422, 429]) expect(isDefiniteRefusal(s)).toBe(true);
    for (const s of [null, undefined, 0, 404, 409, 500, 502, "429"]) expect(isDefiniteRefusal(s)).toBe(false);
  });
});
