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

// Until P3 and P4 bring the Content and Pricing tabs, those parts are
// added on the existing edit page.
export const CONTENT_TAB_INTERIM_NOTE =
  "Dorëshkrimi, kopertina dhe pjesa tjetër e përmbajtjes shtohen ende te faqja e ndryshimit të librit.";
export const PRICING_TAB_INTERIM_NOTE =
  "Çmimi dhe dërgimi për shqyrtim bëhen ende te faqja e ndryshimit të librit.";
export const OPEN_EDIT_PAGE_LABEL = "Hapni faqen e ndryshimit";
