// W4 (Renato 31 Oct, 6a): the rules for when a converted Word manuscript
// may be submitted. Pure, so they are tested directly; manuscript-
// field.tsx only wires them in (see manuscript-field.wiring.test.ts).

export type ManuscriptMode = "epub" | "docx";

// What the surrounding form may submit: the ready temporary EPUB, except
// a Word build the author hasn't confirmed in the preview.
export function submittablePath(mode: ManuscriptMode, path: string | null, approved: boolean): string | null {
  if (!path) return null;
  return mode === "epub" || approved ? path : null;
}

// A submit is stopped (with a message) when a converted Word manuscript
// is ready but not confirmed. While an upload/conversion is still in
// flight, the field's own guard waits for it first and submits again,
// and this is asked again then.
export function shouldBlockSubmit(mode: ManuscriptMode, path: string | null, approved: boolean, inFlight: number): boolean {
  return inFlight === 0 && mode === "docx" && !!path && !approved;
}

// The "I checked the preview" tick in the upload field (audit F3): only
// after the preview of this build has loaded, and never while changes
// are waiting for "Apply" or a rebuild is running.
export function approvalTickState(state: { previewSeen: boolean; pendingChanges: number; applying: boolean }): {
  disabled: boolean;
  reason: string | null;
} {
  if (state.applying) return { disabled: true, reason: "E-libri po rindërtohet me ndryshimet tuaja. Prisni pak." };
  if (state.pendingChanges > 0) {
    const n = state.pendingChanges;
    return {
      disabled: true,
      reason: `Keni ${n} ndryshim${n === 1 ? "" : "e"} pa aplikuar. Hapni pamjen paraprake dhe shtypni “Apliko ndryshimet” ose “Anulo ndryshimet”.`,
    };
  }
  if (!state.previewSeen) return { disabled: true, reason: "Hapni pamjen paraprake më parë." };
  return { disabled: false, reason: null };
}

// An approval stands only while the book shown is the book submitted:
// any change not yet applied, or a rebuild, takes it back.
export function approvalStillValid(approved: boolean, pendingChanges: number, applying: boolean): boolean {
  return approved && pendingChanges === 0 && !applying;
}

// Audit F4 (Supabase egress): the preview copy is downloaded once per
// build, however often the author opens the preview. One entry: a new
// build's path replaces the old one; clear() forgets it.
export function createPreviewCache(download: (path: string) => Promise<Blob>) {
  let entry: { path: string; blob: Promise<Blob> } | null = null;
  return {
    get(path: string): Promise<Blob> {
      if (entry?.path === path) return entry.blob;
      const blob = download(path);
      const mine = { path, blob };
      entry = mine;
      // A failed download is not kept, so opening again retries.
      blob.catch(() => {
        if (entry === mine) entry = null;
      });
      return blob;
    },
    clear() {
      entry = null;
    },
  };
}
