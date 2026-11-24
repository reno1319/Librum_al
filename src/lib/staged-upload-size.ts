// G2 (c2 b): a staged image is checked against its size limit BEFORE it
// is downloaded. The staging bucket ("manuscripts") accepts files up to
// 50 MB, so without this the server read up to 50 MB into memory only to
// refuse it after. Storage's own object info gives the stored size.
//
// Returns "too_large" only when Storage reports a size over the limit.
// When the info call fails or reports no size, it returns "unknown" and
// the caller goes on exactly as before: download, then the byte-length
// check that was already there (kept as the authoritative check).
export type StagedSizeVerdict = "ok" | "too_large" | "unknown";

type InfoCapable = {
  info?: (path: string) => Promise<{ data: { size?: number | null } | null; error: unknown }>;
};

export async function checkStagedUploadSize(
  bucket: InfoCapable,
  path: string,
  maxBytes: number,
): Promise<StagedSizeVerdict> {
  if (typeof bucket.info !== "function") return "unknown";
  try {
    const { data, error } = await bucket.info(path);
    if (error || !data || typeof data.size !== "number" || !Number.isFinite(data.size)) return "unknown";
    return data.size > maxBytes ? "too_large" : "ok";
  } catch {
    return "unknown";
  }
}
