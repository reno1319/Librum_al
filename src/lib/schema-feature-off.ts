// BOOK-PEN-NAME-RIGHTS-CHOICE-1: the application ships before migration
// 20261018091237 is applied, so every new read and write of the pen
// name, the rights declarations and the "Librum's choice" pick treats
// "that column / table / function does not exist yet" as the feature
// being off -- a null read or a clean refusal, never a thrown error or
// a page error. Exactly these codes, and nothing else:
//
//   42703      undefined column (Postgres)
//   42P01      undefined table (Postgres)
//   42883      undefined function (Postgres)
//   PGRST204   column not in PostgREST's schema cache
//   PGRST205   table not in PostgREST's schema cache
//   PGRST202   function not in PostgREST's schema cache
//
// Any other error is a real failure and is handled as one by the caller.
const FEATURE_OFF_CODES: ReadonlySet<string> = new Set([
  "42703",
  "42P01",
  "42883",
  "PGRST204",
  "PGRST205",
  "PGRST202",
]);

export function isSchemaFeatureOffError(error: { code?: string | null } | null | undefined): boolean {
  return typeof error?.code === "string" && FEATURE_OFF_CODES.has(error.code);
}

const loggedFeatures = new Set<string>();

// Logged once per feature per server process, so a page that reads the
// feature on every request does not flood the log before the migration.
export function logSchemaFeatureOffOnce(feature: string, error: { code?: string | null }): void {
  if (loggedFeatures.has(feature)) return;
  loggedFeatures.add(feature);
  console.warn(`${feature}: database objects not present yet (${error.code}); feature off until the migration is applied`);
}

// Tests only: forget which features were logged.
export function resetSchemaFeatureOffLogForTests(): void {
  loggedFeatures.clear();
}
