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

// BD15 P5b-2: a live book in the editor. Its manuscript, ballinë,
// description, 18+ label and original author wait for Librum's review
// (the book stays on sale as it is); everything else saves at once.
export const LIVE_STATUS_LABEL = "Në shitje";
export const LIVE_EDIT_NOTE =
  "Ky libër është në shitje. Ndryshimet në dorëshkrim, ballinë, përshkrim, etiketën 18+ ose autorin origjinal presin miratimin e Librum, ndërsa lexuesit shohin versionin e tanishëm. Ndryshimet e tjera, si çmimi ose kategoritë, dalin menjëherë.";
export const PENDING_CHANGES_LEAD = "Ndryshime që presin dërgimin për shqyrtim:";
export const PENDING_CHANGES_SEND_LINK = "Dërgojini për shqyrtim te Çmimi";
export const DISCARD_CHANGES_BUTTON = "Hidhni ndryshimet";
export const LIVE_MANAGE_LINK = "Hiqeni nga shitja ose fshijeni librin";
export const PENDING_FIELD_LABELS = {
  filePath: "Dorëshkrimi",
  coverPath: "Ballina",
  description: "Përshkrimi",
  isAdult: "Etiketa 18+",
  originalAuthor: "Autori origjinal",
} as const;
export const LIVE_SAVE_BUTTON = "Ruani ndryshimet";
export const LIVE_SAVED_MESSAGE = "Ndryshimet u ruajtën";
export const LIVE_SAVED_PENDING_MESSAGE =
  "Ndryshimet u ruajtën. Ato që kërkojnë shqyrtim nuk dalin te lexuesit pa i dërguar dhe pa i miratuar Librum.";
export const CHANGES_DISCARDED_MESSAGE = "Ndryshimet që prisnin u hodhën. Libri mbetet siç është në shitje.";
export const NO_CHANGES_TO_DISCARD_MESSAGE = "Nuk kishte ndryshime për të hedhur.";
export const SEND_CHANGES_BUTTON = "Dërgoni ndryshimet për shqyrtim";
export const NO_CHANGES_TO_SEND_NOTE = "Nuk keni ndryshime që presin shqyrtim";
export const NO_CHANGES_TO_SEND_MESSAGE =
  "Nuk keni ndryshime që presin shqyrtim. Ndryshoni dorëshkrimin, ballinën, përshkrimin, etiketën 18+ ose autorin origjinal dhe ruajini.";
export const CHANGES_SENT_MESSAGE =
  "Ndryshimet u dërguan për shqyrtim. Libri mbetet në shitje siç është derisa Librum t'i miratojë.";
export const LIVE_NOT_LIVE_MESSAGE =
  "Libri nuk është më në shitje, prandaj ndryshimet nuk u ruajtën. Hapeni përsëri dhe provoni.";
export const LIVE_ADULT_CATEGORY_MESSAGE =
  "Një libër 18+ nuk mund të jetë te Për fëmijë ose Për të rinj. Hiqni ato kategori ose etiketën 18+.";
export const LIVE_RIGHTS_LOCKED_MESSAGE =
  "Të drejtat e një libri në shitje nuk ndryshohen. Për t'i ndryshuar, hiqeni librin nga shitja dhe dërgojeni përsëri.";
export const LIVE_RIGHTS_LOCKED_NOTE =
  "🔒 Të drejtat nuk ndryshohen sa libri është në shitje. Për t'i ndryshuar, hiqeni nga shitja dhe dërgojeni përsëri.";
export const LIVE_REVIEW_FIELD_HINT = "Pret miratimin e Librum para se ta shohin lexuesit.";
export const LIVE_EDIT_IN_EDITOR_NOTE =
  "Libri mbetet në shitje ndërsa e ndryshoni te redaktori. Ndryshimet në dorëshkrim, ballinë, përshkrim, etiketën 18+ ose autorin origjinal presin miratimin e Librum.";
export const LIVE_IN_REVIEW_NOTE =
  "Libri mbetet në shitje siç është. Lexuesit shohin ndryshimet vetëm pasi Librum t'i miratojë.";

// BD15 P5b-2 (audit r1 F2): a live book's changes in review, and after
// "Anuloni shqyrtimin" -- it never stopped being on sale.
export const LIVE_IN_REVIEW_PUBLISHING_NOTE =
  "Librum po kontrollon ndryshimet tuaja. Libri mbetet në shitje siç është derisa t'i miratojmë.";
export const LIVE_REVIEW_CANCELLED_MESSAGE =
  "Shqyrtimi u anulua. Libri mbetet në shitje; ndryshimet tuaja presin përsëri te redaktori.";
// Audit r1 F5: the live fields were saved, the waiting ones were not.
export const LIVE_PARTLY_SAVED_MESSAGE =
  "Ndryshimet e tjera u ruajtën, por përshkrimi, etiketa 18+ dhe autori origjinal nuk u ruajtën. Rifreskoni faqen dhe provoni përsëri.";
