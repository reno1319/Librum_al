import "server-only";

// ALL-CUTOVER APP-A: the single, server-only source of truth for
// whether the ALL-currency cutover's temporary maintenance window is
// active. Never imported into any client component, never exposed to
// the browser (no NEXT_PUBLIC_ prefix), and never overridable by
// request input (query/body/cookie) -- the only input this ever reads
// is the server's own ALL_CUTOVER_MAINTENANCE_MODE env var, at each
// call site, the same way src/lib/checkout-regime.ts's
// resolveCheckoutRegime() is read directly from process.env at every
// one of its call sites rather than through a wrapper.
//
// PRE-CUTOVER default (mirrors resolveCheckoutRegime's own documented
// rationale exactly): missing, empty, whitespace-only, wrongly-cased,
// or any other unrecognized value all resolve to "not active". Exact,
// case-sensitive, untrimmed string match only: neither "Active" nor
// " active" (leading space) is coerced into the active state --
// silently tolerating a near-miss here is exactly the class of
// accident that could either (a) leave real money-moving traffic
// running during a live cutover window, or (b) leave the app
// accidentally stuck in maintenance after the window should have
// lifted.
const MAINTENANCE_ACTIVE_VALUE = "active";

export function resolveMaintenanceMode(raw: string | undefined): boolean {
  return raw === MAINTENANCE_ACTIVE_VALUE;
}
