"use client";

import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CleanupReport } from "@/lib/docx-cleanup";
import type { ConversionWarning } from "@/lib/docx-converter";
import type { CleanupGuess } from "@/lib/docx-structure";
import {
  MAX_CHAPTER_TITLE_CHARS,
  applyTap,
  canToggleGuess,
  healthReport,
  describeGuess,
  guessWillApply,
  guessesForList,
  isGuessPending,
  pendingChanges,
  pendingCount,
  toggleGuess,
  undoTap,
  type PreviewChoices,
  type TapAction,
} from "@/lib/docx-preview-choices";
import {
  marksInChapter,
  parseChapterXhtml,
  scopeStylesheet,
  type PreviewElement,
  type PreviewNode,
} from "@/lib/ebook-preview-html";

// W4: the author's preview of a Word-made ebook (Renato 31 Oct: 1a the
// whole book readable, chapter by chapter, with a summary of what
// Librum changed; 2a every guess can be undone; 3a any short line can
// be made a chapter; 4a one "Apply" rebuilds once; 6a the author
// confirms the book looks right). Reads the preview copy straight from
// the author's own private storage folder (never through Vercel), and
// renders it through ebook-preview-html.ts's allow-list.

export type PreviewChapter = { heading: string | null; headingPara: number | null };
export type PreviewBuild = {
  previewPath: string;
  cleanup: CleanupReport;
  chapters: PreviewChapter[];
  warnings: ConversionWarning[];
};

type LoadedBook = {
  css: string;
  pages: string[]; // chapter XHTML, one per chapter
  images: Map<string, string>; // "images/img-1.png" -> blob URL
  // Word paragraph number -> chapter index (for "Show in the book").
  where: Map<number, number>;
};

type Selection = { paragraph: number; text: string; action: TapAction | null; note?: string };

const SCOPE_CLASS = "librum-ebook-preview";
const LIST_STEP = 40;

export function EbookPreview({
  build,
  choices,
  appliedChoices,
  onChoicesChange,
  onApply,
  applying,
  applyError,
  onApprove,
  onClose,
  onLoaded,
  download,
}: {
  build: PreviewBuild;
  choices: PreviewChoices;
  appliedChoices: PreviewChoices;
  onChoicesChange: (next: PreviewChoices) => void;
  onApply: () => void;
  applying: boolean;
  applyError: string;
  onApprove: () => void;
  onClose: () => void;
  // Called once this build's chapters are on screen.
  onLoaded: () => void;
  download: (path: string) => Promise<Blob>;
}) {
  // Each state remembers the build it belongs to, so a rebuild shows
  // "loading" and drops a stale selection without resetting in an effect.
  const [loaded, setLoaded] = useState<{ path: string; book: LoadedBook } | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [chapterState, setChapter] = useState(0);
  const [pane, setPane] = useState<"read" | "check">("read");
  const [selectedState, setSelectedState] = useState<{ path: string; s: Selection } | null>(null);
  const [tapTexts, setTapTexts] = useState<Map<number, string>>(() => new Map());
  const book = loaded?.path === build.previewPath ? loaded.book : null;
  const loadError = failedPath === build.previewPath;
  const chapter = Math.min(chapterState, Math.max(0, build.chapters.length - 1));
  const selected = selectedState?.path === build.previewPath ? selectedState.s : null;
  const setSelected = (s: Selection | null) => setSelectedState(s ? { path: build.previewPath, s } : null);
  const [listLimit, setListLimit] = useState(LIST_STEP);
  const [focusPara, setFocusPara] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);

  // Load (and reload after every rebuild) the preview copy.
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const path = build.previewPath;
    (async () => {
      try {
        const blob = await download(path);
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(await blob.arrayBuffer());
        const css = (await zip.file("OEBPS/styles.css")?.async("string")) ?? "";
        const pages: string[] = [];
        for (let i = 0; i < build.chapters.length; i++) {
          pages.push((await zip.file(`OEBPS/chapter-${i + 1}.xhtml`)?.async("string")) ?? "");
        }
        const images = new Map<string, string>();
        for (const entry of Object.values(zip.files)) {
          const m = entry.name.match(/^OEBPS\/(images\/img-\d{1,4}\.(png|jpg|gif))$/);
          if (!m || entry.dir) continue;
          const type = m[2] === "png" ? "image/png" : m[2] === "gif" ? "image/gif" : "image/jpeg";
          const url = URL.createObjectURL(new Blob([await entry.async("arraybuffer")], { type }));
          urls.push(url);
          images.set(m[1], url);
        }
        const where = new Map<number, number>();
        pages.forEach((page, i) => {
          const marks = marksInChapter(page);
          for (const p of [...marks.paragraphs, ...marks.sceneBreaks]) if (!where.has(p)) where.set(p, i);
        });
        build.chapters.forEach((c, i) => {
          if (c.headingPara !== null) where.set(c.headingPara, i);
        });
        if (cancelled) return;
        setLoaded({ path, book: { css: scopeStylesheet(css, `.${SCOPE_CLASS}`), pages, images, where } });
        onLoaded();
      } catch (err) {
        console.error("EbookPreview: preview failed to load:", err);
        if (!cancelled) setFailedPath(path);
      }
    })();
    return () => {
      cancelled = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build.previewPath]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodes = useMemo(() => (book ? parseChapterXhtml(book.pages[chapter] ?? "") : []), [book, chapter]);

  // Scroll to a line after "Show in the book".
  useEffect(() => {
    if (focusPara === null || !readerRef.current) return;
    const el = readerRef.current.querySelector(
      `[data-p="${focusPara}"], [data-s="${focusPara}"], [data-heading-para="${focusPara}"]`,
    );
    const block = el?.closest("p, h1, h2, h3, h4, li, blockquote") ?? el;
    if (block instanceof HTMLElement) {
      block.scrollIntoView({ block: "center" });
      block.classList.add("librum-preview-flash");
      window.setTimeout(() => block.classList.remove("librum-preview-flash"), 2000);
    } else {
      readerRef.current.scrollTop = 0;
    }
    setFocusPara(null);
  }, [focusPara, nodes]);

  const guesses = useMemo(() => guessesForList(build.cleanup).filter((g) => g.kind !== "title_page"), [build.cleanup]);
  const titlePage = build.cleanup.guesses.find((g) => g.kind === "title_page");
  const health = healthReport(build.cleanup, build.warnings);
  const pending = pendingCount(choices, appliedChoices);
  const ownChanges = pendingChanges(choices, appliedChoices).filter(
    (c) => c.kind !== "other" && !build.cleanup.guesses.some((g) => g.paragraph === c.paragraph && (g.kind === "chapter" || g.kind === "scene_break" || g.kind === "subheading")),
  );
  const marked = build.chapters.some((c) => c.headingPara !== null);
  const showQuotes = build.cleanup.applied;

  function showInBook(paragraph: number) {
    const at = book?.where.get(paragraph);
    if (at === undefined) return;
    setChapter(at);
    setPane("read");
    setFocusPara(paragraph);
  }

  function onReaderClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!marked || applying) return;
    const target = e.target as HTMLElement;
    const block = target.closest("p, h1, h2, h3, h4, li, blockquote");
    if (!block || !readerRef.current?.contains(block)) return;
    const text = (block.textContent ?? "").replace(/\s+/g, " ").trim();
    const short = text.length > 80 ? `${text.slice(0, 79)}…` : text;
    if (block.tagName === "H1") {
      const p = block.getAttribute("data-heading-para");
      if (p === null) return;
      setSelected({ paragraph: Number(p), text: short, action: "notChapter" });
      return;
    }
    const scene = block.querySelector(":scope > span[data-s]");
    if (scene) {
      setSelected({ paragraph: Number(scene.getAttribute("data-s")), text: "* * *", action: "noSceneBreak" });
      return;
    }
    const mark = block.querySelector(":scope > span[data-p]") ?? (block.tagName === "LI" ? null : block.querySelector("span[data-p]"));
    if (!mark) return;
    const paragraph = Number(mark.getAttribute("data-p"));
    if (text.length === 0) return;
    if (text.length > MAX_CHAPTER_TITLE_CHARS) {
      setSelected({ paragraph, text: short, action: null, note: "Vetëm një rresht i shkurtër mund të bëhet titull kapitulli." });
      return;
    }
    setSelected({ paragraph, text: short, action: "makeChapter" });
  }

  function doTap(s: Selection) {
    if (!s.action) return;
    setTapTexts((m) => new Map(m).set(s.paragraph, s.text));
    onChoicesChange(applyTap(choices, s.action, s.paragraph));
    setSelected(null);
  }

  function renderNode(node: PreviewNode, key: number): ReactNode {
    if (typeof node === "string") return node;
    return renderElement(node, key);
  }

  function renderElement(el: PreviewElement, key: number): ReactNode {
    const children = el.children.map(renderNode);
    const props: Record<string, unknown> = { key };
    if (el.attrs.class) props.className = el.attrs.class;
    if (el.attrs["data-p"]) props["data-p"] = el.attrs["data-p"];
    if (el.attrs["data-s"]) props["data-s"] = el.attrs["data-s"];
    if (el.attrs.colspan) props.colSpan = Number(el.attrs.colspan);
    if (el.attrs.rowspan) props.rowSpan = Number(el.attrs.rowspan);
    switch (el.tag) {
      case "img": {
        const url = book?.images.get(el.attrs.src);
        // eslint-disable-next-line @next/next/no-img-element
        return url ? <img key={key} src={url} alt={el.attrs.alt ?? ""} /> : null;
      }
      case "br":
      case "hr":
        return createElement(el.tag, { key });
      case "a":
        // Links are shown, never followed, inside the preview.
        return (
          <span key={key} className="underline">
            {children}
          </span>
        );
      default:
        return createElement(el.tag, props, ...children);
    }
  }

  // The chapter title: the ebook writes it as the page's <h1>; the
  // preview adds the Word paragraph number so a tap can undo it.
  // Lines with a change not yet applied are outlined.
  const pendingParas = new Set(pendingChanges(choices, appliedChoices).map((c) => c.paragraph));
  const pageNodes = nodes.map((n, i) => {
    if (typeof n !== "string" && n.tag === "h1") {
      const headingPara = build.chapters[chapter]?.headingPara;
      return (
        <h1
          key={i}
          data-heading-para={headingPara ?? undefined}
          className={headingPara != null && pendingParas.has(headingPara) ? "librum-preview-pending" : undefined}
        >
          {n.children.map(renderNode)}
        </h1>
      );
    }
    if (typeof n !== "string" && pendingParas.size > 0) {
      const first = n.children[0];
      const mark = typeof first !== "string" && first?.tag === "span" ? (first.attrs["data-p"] ?? first.attrs["data-s"]) : undefined;
      if (mark !== undefined && pendingParas.has(Number(mark))) {
        return renderElement({ ...n, attrs: { ...n.attrs, class: `${n.attrs.class ?? ""} librum-preview-pending`.trim() } }, i);
      }
    }
    return renderNode(n, i);
  });

  const chapterLabel = (c: PreviewChapter, i: number) => c.heading ?? (i === 0 ? "Fillimi" : `Pjesa ${i + 1}`);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ebook-preview-title"
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
    >
      <style>{`${book?.css ?? ""}
.${SCOPE_CLASS} { max-width: 38rem; margin: 0 auto; padding: 1.5rem 1rem 6rem; font-size: 1.05rem; }
.${SCOPE_CLASS} p, .${SCOPE_CLASS} h1, .${SCOPE_CLASS} h2, .${SCOPE_CLASS} h3, .${SCOPE_CLASS} h4, .${SCOPE_CLASS} li { cursor: pointer; border-radius: 2px; }
.${SCOPE_CLASS} p:hover, .${SCOPE_CLASS} h1:hover, .${SCOPE_CLASS} h2:hover, .${SCOPE_CLASS} li:hover { background: rgba(31, 92, 63, 0.06); }
.${SCOPE_CLASS} .librum-preview-flash { outline: 3px solid #1f5c3f; outline-offset: 2px; }
.${SCOPE_CLASS} .librum-preview-pending { outline: 2px dashed #1f5c3f; outline-offset: 2px; background: #f4f8f5; }
.${SCOPE_CLASS} img { height: auto; }
`}</style>

      <header className="flex items-center gap-3 border-b border-[#c9c0ae] px-4 py-3">
        <h2 id="ebook-preview-title" className="flex-1 text-base font-semibold">
          Pamja paraprake e e-librit
        </h2>
        <div className="flex rounded-[4px] border border-[#c9c0ae] text-sm lg:hidden">
          <button
            type="button"
            onClick={() => setPane("read")}
            className={`min-h-11 px-3 ${pane === "read" ? "bg-primary text-white" : ""}`}
            aria-pressed={pane === "read"}
          >
            Lexo
          </button>
          <button
            type="button"
            onClick={() => setPane("check")}
            className={`min-h-11 px-3 ${pane === "check" ? "bg-primary text-white" : ""}`}
            aria-pressed={pane === "check"}
          >
            Kontrollo{pending > 0 ? ` (${pending})` : ""}
          </button>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="focus-ring min-h-11 rounded-[3px] border border-primary px-3 text-sm font-semibold text-primary"
        >
          Mbyll
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`${pane === "check" ? "flex" : "hidden"} w-full min-h-0 flex-col gap-4 overflow-y-auto border-r border-[#c9c0ae] p-4 text-sm lg:flex lg:w-[24rem] lg:shrink-0`}
        >
          <section>
            <h3 className="mb-1 font-semibold">Çfarë rregulloi Librum</h3>
            {!health.some((h) => h.tone === "ok") && (
              <p className="text-muted">Librum e ktheu dokumentin siç është, me kapitujt e ruajtur nga Heading 1 të Word-it.</p>
            )}
            {health.length > 0 && (
              // W3 Part 2: the health report; green = done, amber = look at it.
              <ul className="flex flex-col gap-1">
                {health.map((h, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 rounded-[4px] px-2 py-1 ${h.tone === "ok" ? "bg-[#eef5ef] text-[#1f4d33]" : "bg-[#fbf1dc] text-[#6b4a0f]"}`}
                  >
                    <span aria-hidden="true">{h.tone === "ok" ? "✓" : "!"}</span>
                    <span>
                      <span className="sr-only">{h.tone === "ok" ? "Në rregull: " : "Kontrolloje: "}</span>
                      {h.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {titlePage && <p className="mt-1 text-muted">{describeGuess(titlePage, true, false).state}</p>}
            {showQuotes && (
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-primary"
                  checked={choices.fixQuotes}
                  disabled={applying}
                  onChange={(e) => onChoicesChange({ ...choices, fixQuotes: e.target.checked })}
                />
                <span>
                  Rregullo thonjëzat, apostrofat, tre pikat dhe vizat e dialogut
                  {choices.fixQuotes !== appliedChoices.fixQuotes && <em className="text-primary"> (pas aplikimit)</em>}
                </span>
              </label>
            )}
          </section>

          {ownChanges.length > 0 && (
            <section>
              <h3 className="mb-1 font-semibold">Ndryshimet tuaja</h3>
              <ul className="flex flex-col gap-2">
                {ownChanges.map((c) => {
                  const action: TapAction = c.kind === "scene_break" ? "noSceneBreak" : c.on ? "makeChapter" : "notChapter";
                  const text = tapTexts.get(c.paragraph);
                  const label =
                    action === "makeChapter"
                      ? "Bëhet fillim kapitulli"
                      : action === "notChapter"
                        ? "Nuk është më kapitull"
                        : "Ndarja e skenës hiqet";
                  return (
                    <li key={`${c.kind}:${c.paragraph}`} className="rounded-[4px] border border-[#c9c0ae] bg-surface p-2">
                      <p>
                        {label}
                        {text ? `: “${text}”` : ""}
                      </p>
                      <button
                        type="button"
                        disabled={applying}
                        className="mt-1 min-h-11 text-sm font-semibold text-primary underline"
                        onClick={() => onChoicesChange(undoTap(choices, appliedChoices, action, c.paragraph))}
                      >
                        Anuloje
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {guesses.length > 0 && (
            <section>
              <h3 className="mb-1 font-semibold">Kontrolloni këto</h3>
              <p className="mb-2 text-xs text-muted">
                Librum i vendosi vetë këto. Kontrolloji me kujdes ato me shenjën “I pasigurt”.
              </p>
              <ul className="flex flex-col gap-2">
                {guesses.slice(0, listLimit).map((g) => (
                  <GuessRow
                    key={`${g.kind}:${g.paragraph}`}
                    guess={g}
                    choices={choices}
                    appliedChoices={appliedChoices}
                    disabled={applying}
                    canShow={book?.where.has(g.paragraph) ?? false}
                    onToggle={() => onChoicesChange(toggleGuess(g, choices, appliedChoices))}
                    onShow={() => showInBook(g.paragraph)}
                  />
                ))}
              </ul>
              {guesses.length > listLimit && (
                <button
                  type="button"
                  className="mt-2 text-sm font-semibold text-primary underline"
                  onClick={() => setListLimit((n) => n + LIST_STEP)}
                >
                  Shfaq më shumë ({guesses.length - listLimit})
                </button>
              )}
            </section>
          )}

        </aside>

        <main className={`${pane === "read" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col lg:flex`}>
          <div className="flex flex-wrap items-center gap-2 border-b border-[#c9c0ae] px-4 py-2 text-sm">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 font-semibold">Kapitulli</span>
              <select
                className="focus-ring min-h-11 min-w-0 flex-1 rounded-[3px] border border-[#c9c0ae] bg-surface px-2"
                value={chapter}
                onChange={(e) => setChapter(Number(e.target.value))}
              >
                {build.chapters.map((c, i) => (
                  <option key={i} value={i}>
                    {i + 1}. {chapterLabel(c, i)}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-muted">{build.chapters.length} gjithsej</span>
          </div>
          {marked && (
            <p className="border-b border-[#c9c0ae] bg-surface px-4 py-2 text-xs text-muted">
              Zgjidhni një rresht për ta bërë fillim kapitulli, ose një titull kapitulli a një ndarje skene për ta hequr.
            </p>
          )}
          <div ref={readerRef} className="min-h-0 flex-1 overflow-y-auto bg-white" onClick={onReaderClick}>
            {loadError ? (
              <p role="alert" className="p-4 text-sm text-red-800">
                Pamja paraprake nuk u hap dot. Mbylleni dhe provoni sërish.
              </p>
            ) : !book ? (
              <p role="status" className="p-4 text-sm text-muted">
                E-libri po hapet…
              </p>
            ) : (
              <div className={SCOPE_CLASS} lang="sq">
                {pageNodes}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-[#c9c0ae] px-4 py-2 text-sm">
            <button
              type="button"
              className="min-h-11 font-semibold text-primary disabled:opacity-40"
              disabled={chapter === 0}
              onClick={() => setChapter((c) => Math.max(0, c - 1))}
            >
              ‹ Kapitulli i mëparshëm
            </button>
            <button
              type="button"
              className="min-h-11 font-semibold text-primary disabled:opacity-40"
              disabled={chapter >= build.chapters.length - 1}
              onClick={() => setChapter((c) => Math.min(build.chapters.length - 1, c + 1))}
            >
              Kapitulli tjetër ›
            </button>
          </div>
        </main>
      </div>

      {selected && (
        <div role="region" aria-label="Rreshti i zgjedhur" className="border-t-2 border-primary bg-surface px-4 py-3 text-sm">
          <p className="mb-2">
            <span className="font-semibold">Rreshti i zgjedhur:</span> “{selected.text}”
          </p>
          {selected.note && <p className="mb-2 text-muted">{selected.note}</p>}
          <div className="flex flex-wrap gap-2">
            {selected.action && (
              <button
                type="button"
                className="focus-ring min-h-11 rounded-[3px] bg-primary px-4 font-semibold text-white"
                onClick={() => doTap(selected)}
              >
                {selected.action === "makeChapter"
                  ? "Bëje kapitull"
                  : selected.action === "notChapter"
                    ? "Ky nuk është kapitull"
                    : "Hiqe këtë ndarje skene"}
              </button>
            )}
            <button
              type="button"
              className="focus-ring min-h-11 rounded-[3px] border border-primary px-4 font-semibold text-primary"
              onClick={() => setSelected(null)}
            >
              Anulo
            </button>
          </div>
        </div>
      )}

      <footer className="flex flex-col gap-2 border-t border-[#c9c0ae] bg-surface px-4 py-3 text-sm sm:flex-row sm:items-center">
        <div className="flex-1" role="status">
          {applying
            ? "E-libri po rindërtohet me ndryshimet tuaja…"
            : pending > 0
              ? `${pending} ndryshim${pending === 1 ? "" : "e"} ende pa u aplikuar.`
              : "E-libri që shihni është varianti që do të dërgohet për shqyrtim."}
          {applyError && (
            <p role="alert" className="mt-1 text-red-800">
              {applyError}
            </p>
          )}
        </div>
        {pending > 0 ? (
          <>
            <button
              type="button"
              disabled={applying}
              className="focus-ring min-h-11 rounded-[3px] border border-primary px-4 font-semibold text-primary disabled:opacity-60"
              onClick={() => onChoicesChange(appliedChoices)}
            >
              Anulo ndryshimet
            </button>
            <button
              type="button"
              disabled={applying}
              className="focus-ring min-h-11 rounded-[3px] bg-primary px-4 font-semibold text-white disabled:opacity-60"
              onClick={onApply}
            >
              Apliko ndryshimet
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={applying || !book}
            className="focus-ring min-h-11 rounded-[3px] bg-primary px-4 font-semibold text-white disabled:opacity-60"
            onClick={onApprove}
          >
            E kontrollova, libri duket mirë
          </button>
        )}
      </footer>
    </div>
  );
}

function GuessRow({
  guess,
  choices,
  appliedChoices,
  disabled,
  canShow,
  onToggle,
  onShow,
}: {
  guess: CleanupGuess;
  choices: PreviewChoices;
  appliedChoices: PreviewChoices;
  disabled: boolean;
  canShow: boolean;
  onToggle: () => void;
  onShow: () => void;
}) {
  const pending = isGuessPending(guess, choices, appliedChoices);
  const on = guessWillApply(guess, choices, appliedChoices);
  const toggle = pending || canToggleGuess(guess, appliedChoices);
  const words = describeGuess(guess, on, toggle);
  return (
    <li className={`rounded-[4px] border p-2 ${pending ? "border-primary bg-[#f4f8f5]" : "border-[#c9c0ae] bg-surface"}`}>
      <p>
        {words.unsure && <span className="mr-1 rounded-[3px] bg-[#fdf1d6] px-1 text-xs font-semibold text-[#7a4d00]">I pasigurt</span>}
        {words.state}
        {pending && <em className="text-primary"> (pas aplikimit)</em>}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-4">
        {words.action && (
          <button type="button" disabled={disabled} className="min-h-11 font-semibold text-primary underline disabled:opacity-60" onClick={onToggle}>
            {pending ? "Ktheje si ishte" : words.action}
          </button>
        )}
        {canShow && (
          <button type="button" className="min-h-11 text-primary underline" onClick={onShow}>
            Shfaq në libër
          </button>
        )}
      </div>
    </li>
  );
}
