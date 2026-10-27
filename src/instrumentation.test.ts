import { afterEach, describe, expect, it, vi } from "vitest";

const reportServerError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/error-alerts", () => ({ reportServerError }));

import { onRequestError } from "@/instrumentation";

const REQUEST = { path: "/x", method: "GET", headers: {} };
const CONTEXT = {
  routerKind: "App Router",
  routePath: "/x",
  routeType: "render",
  renderSource: "server-rendering",
  revalidateReason: undefined,
  renderType: "dynamic",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  reportServerError.mockClear();
});

describe("onRequestError", () => {
  it("passes server errors to the error alerts on Node.js", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const error = new Error("boom");
    await onRequestError(error, REQUEST, CONTEXT);
    expect(reportServerError).toHaveBeenCalledWith(error, REQUEST, CONTEXT);
  });

  it("does nothing on Edge", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await onRequestError(new Error("boom"), REQUEST, CONTEXT);
    expect(reportServerError).not.toHaveBeenCalled();
  });
});
