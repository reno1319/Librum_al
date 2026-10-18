// iPhone step (I3): the Edit page names the current manuscript by its
// kind, never by its storage file name (a UUID such as
// "26525d0c-....epub" that means nothing to an author). Stored
// manuscripts are EPUB; any other extension, or none, is just "file".
// null means there is no manuscript on file.
export function getManuscriptLabel(filePath: string | null | undefined): string | null {
  const name = filePath?.split("/").pop() ?? "";
  if (name === "") return null;
  return name.toLowerCase().endsWith(".epub") ? "EPUB file" : "file";
}
