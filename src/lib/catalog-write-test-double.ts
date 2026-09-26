// TEST-ONLY. Never imported by application code.
//
// CATALOG-WRITE-AUTH-1: the protected book/bundle writes now go through
// createCatalogWriteClient() (src/lib/catalog-write-client.ts) instead of
// the author's session client. Many focused suites assert on the payloads
// and filters their session-client double receives; this helper lets such
// a suite route the catalog writer to that SAME double, so those
// assertions keep seeing every write, without re-implementing the double.
//
// It records the synchronous query-builder calls (`.from().update().eq()
// ...select()`) and replays them against the client `resolveClient`
// returns only when the query is awaited, so a per-test override of the
// session double (mockImplementationOnce and the like) applies to the
// catalog write too.
//
// WHICH client performs which write is deliberately NOT this helper's
// concern: that boundary is pinned against two distinct doubles in
// src/app/(public)/dashboard/catalog-write-authorization.test.ts.

type Queryable = { from(table: string): unknown; rpc?(fn: string, args?: unknown): unknown };
type Recorded = { method: string | symbol; args: unknown[] };

export function catalogWriterReplayingOnto(
  resolveClient: () => Queryable | Promise<Queryable>,
): Required<Queryable> {
  return {
    // BUNDLE-MEMBERSHIP-AUTH-1: the trusted membership writers are RPCs
    // (create_bundle_with_membership / update_bundle_with_membership). The
    // call is forwarded to the same double only when awaited, like `from`.
    rpc(fn: string, args?: unknown) {
      return {
        then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          return Promise.resolve(resolveClient())
            .then((client) => {
              if (typeof client.rpc !== "function") {
                throw new Error("catalog writer double: rpc is not supported by this client double");
              }
              return client.rpc(fn, args);
            })
            .then(onFulfilled, onRejected);
        },
      };
    },
    from(table: string) {
      const calls: Recorded[] = [];
      const proxy: object = new Proxy(
        {},
        {
          get(_target, method) {
            if (method === "then") {
              return (
                onFulfilled?: (value: unknown) => unknown,
                onRejected?: (reason: unknown) => unknown,
              ) =>
                Promise.resolve(resolveClient())
                  .then((client) => {
                    let query = client.from(table) as Record<string | symbol, unknown>;
                    for (const call of calls) {
                      const next = query[call.method];
                      if (typeof next !== "function") {
                        throw new Error(`catalog writer double: ${String(call.method)} is not supported`);
                      }
                      query = next.apply(query, call.args) as Record<string | symbol, unknown>;
                    }
                    return query;
                  })
                  .then(onFulfilled, onRejected);
            }
            return (...args: unknown[]) => {
              calls.push({ method, args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
}
