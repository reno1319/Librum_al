// BD15 P2: the new book editor's words and its URL, shared by the page,
// the client form and the server actions.

export type EditorTab = "details" | "content" | "pricing";

export const EDITOR_TABS: readonly { key: EditorTab; label: string }[] = [
  { key: "details", label: "Të dhënat" },
  { key: "content", label: "Përmbajtja" },
  { key: "pricing", label: "Çmimi" },
];

export function isEditorTab(value: unknown): value is EditorTab {
  return value === "details" || value === "content" || value === "pricing";
}

export function editorPath(bookId: string, tab: EditorTab): string {
  return `/dashboard/books/${bookId}/editor?tab=${tab}`;
}

export const DETAILS_SAVED_MESSAGE = "U ruajt si draft";
export const DETAILS_INVALID_MESSAGE = "Disa fusha nuk janë plotësuar si duhet. Kontrolloni të dhënat dhe provoni përsëri.";
export const SAVE_FAILED_MESSAGE = "Diçka shkoi keq gjatë ruajtjes së librit. Provoni përsëri";
export const SERIES_NOT_OWN_MESSAGE = "Zgjidhni një nga seritë tuaja";
export const CONTRIBUTORS_NOT_SAVED_MESSAGE =
  "Të dhënat u ruajtën, por kontribuesit jo të gjithë. Kontrolloni listën dhe ruajeni përsëri.";
export const RIGHTS_NOT_SAVED_MESSAGE =
  "Të dhënat u ruajtën, por zgjedhja e të drejtave jo. Zgjidheni përsëri dhe ruajeni.";
export const EDITOR_ONLY_DRAFTS_MESSAGE =
  "Ky libër është i publikuar ose në shqyrtim, prandaj ndryshohet këtu.";

export const TITLE_LOCKED_NOTE =
  "🔒 Titulli nuk ndryshohet pasi libri publikohet. Për ta korrigjuar, shkruani te Ndihma.";
export const PEN_NAME_LOCKED_NOTE = "🔒 Emri i autorit nuk ndryshohet pasi libri publikohet.";
export const TITLE_WILL_LOCK_NOTE = "Pas publikimit titulli nuk mund të ndryshohet më.";


// BD15 P3: the Content tab.
export const CONTENT_SAVED_MESSAGE = DETAILS_SAVED_MESSAGE;
export const AI_NOT_SAVED_MESSAGE =
  "Përgjigja për AI nuk u ruajt. Zgjidheni përsëri dhe ruajeni.";
export const AI_QUESTION =
  "A keni përdorur AI për të krijuar tekstin, përkthimin ose ballinën?";
export const AI_STAFF_ONLY_NOTE =
  "Këtë përgjigje e sheh vetëm ekipi i Librum. Nuk shfaqet në faqen e librit.";
export const DRM_FREE_NOTE =
  "Të gjithë librat në Librum shiten pa DRM: lexuesi mund ta hapë në çdo pajisje.";
