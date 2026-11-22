"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Extension, getMarkRange } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isAllowedBlogHref, isLibrumHref, opensInNewTab, shortBlogHref, typedTextToHref, cleanLinkSearchTerm } from "@/lib/blog-links";
import { searchBlogLinkTargets, type LinkSearchHit } from "./link-search-actions";

// Blog editor links (Renato 2026-11-22, pictures approved 10:32 UTC):
// - LinkSearchBox: the 🔗 box that opens under the selected words (🔗
//   Link button or Ctrl+K / Cmd+K). Type to search Librum (books,
//   authors, articles: public pages only, lk2 a), or paste a web
//   address. ↑ ↓ choose, Enter links, Esc closes.
// - LinkBar: clicking an existing link shows its address with Open ↗ /
//   Change / Remove.
// The look follows the approved pictures (link.cjs mock).

export type AnchorRect = { left: number; bottom: number };

const POP_CLASS =
  "absolute z-50 overflow-hidden rounded-[12px] border border-[#d9d2c3] bg-[#fffdf8] text-[14px] text-[#222] shadow-[0_10px_30px_rgba(0,0,0,.18)]";
const SUB = "text-[12.5px] text-[#6b6458]";
const PILL = "focus-ring rounded-full border border-[#d9d2c3] bg-white px-2.5 py-1 hover:bg-background";

function popWidth() {
  return Math.min(380, window.innerWidth - 24);
}

// Under the words, kept inside the window (12 px from each side).
function popStyle(anchor: AnchorRect): React.CSSProperties {
  const width = popWidth();
  const left = Math.max(12, Math.min(anchor.left + window.scrollX, window.innerWidth - width - 12));
  return { top: anchor.bottom + window.scrollY + 8, left, width };
}

// Where the selected words (or the link the cursor is in) end on screen.
export function selectionAnchor(editor: Editor): AnchorRect | null {
  const { view, state } = editor;
  try {
    if (state.selection.empty) {
      const link = linkElementAt(editor);
      if (link) {
        const r = link.getBoundingClientRect();
        return { left: r.left, bottom: r.bottom };
      }
    }
    const from = view.coordsAtPos(state.selection.from);
    const to = view.coordsAtPos(state.selection.to);
    return { left: from.left, bottom: Math.max(from.bottom, to.bottom) };
  } catch {
    return null;
  }
}

export function linkElementAt(editor: Editor): HTMLAnchorElement | null {
  try {
    const { node, offset } = editor.view.domAtPos(editor.state.selection.from);
    const el = node.nodeType === Node.ELEMENT_NODE ? ((node as Element).childNodes[offset] ?? node) : node.parentNode;
    const start = el && el.nodeType === Node.ELEMENT_NODE ? (el as Element) : (el?.parentElement ?? null);
    return (start?.closest("a") as HTMLAnchorElement | null) ?? null;
  } catch {
    return null;
  }
}

// Links the selected words. With nothing selected (and not inside a
// link), the chosen title (or the address) is added as linked words.
export function applyLink(editor: Editor, href: string, words: string) {
  const chain = editor.chain().focus();
  if (editor.state.selection.empty && !editor.isActive("link")) {
    chain.insertContent({ type: "text", text: words, marks: [{ type: "link", attrs: { href } }] }).run();
  } else {
    chain.extendMarkRange("link").setLink({ href }).run();
  }
}

type Row = { href: string; words: string; hit: LinkSearchHit | null };

const GROUPS: { kind: LinkSearchHit["kind"]; head: string }[] = [
  { kind: "book", head: "Libra" },
  { kind: "author", head: "Autorë" },
  { kind: "post", head: "Artikuj" },
];

function HitIcon({ hit }: { hit: LinkSearchHit | null }) {
  if (!hit) {
    return <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[6px] bg-[#e7e1d3]">🔗</span>;
  }
  if (hit.kind === "book") {
    return hit.imageUrl ? (
      // eslint-disable-next-line @next/next/no-img-element -- a small public cover from Storage.
      <img src={hit.imageUrl} alt="" className="h-10 w-7 flex-none rounded-[3px] object-cover" />
    ) : (
      <span className="h-10 w-7 flex-none rounded-[3px] bg-[#2f5d50]" />
    );
  }
  if (hit.kind === "author") {
    return (
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[#c9b48a] font-semibold text-white">
        {hit.title.trim().charAt(0).toUpperCase()}
      </span>
    );
  }
  return <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[6px] bg-[#e7e1d3]">📝</span>;
}

export function LinkSearchBox({
  editor,
  anchor,
  initial,
  onClose,
}: {
  editor: Editor;
  anchor: AnchorRect;
  initial: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<LinkSearchHit[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const typedHref = typedTextToHref(q);
  const term = typedHref ? null : cleanLinkSearchTerm(q);

  // The words to be linked stay highlighted while the box is open.
  useEffect(() => {
    const { from, to } = editor.state.selection;
    setLinkTargetHighlight(editor, { from, to });
    return () => {
      if (!editor.isDestroyed) setLinkTargetHighlight(editor, null);
    };
  }, [editor]);

  useEffect(() => {
    if (!term) return;
    let stale = false;
    const timer = setTimeout(async () => {
      setStatus("searching");
      try {
        const result = await searchBlogLinkTargets(term);
        if (stale) return;
        setHits(result.ok ? result.hits : []);
        setStatus(result.ok ? "done" : "error");
        setActive(0);
      } catch {
        if (!stale) setStatus("error");
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [term]);

  // Closes when staff click anywhere else.
  useEffect(() => {
    function away(e: MouseEvent) {
      const target = e.target as Element | null;
      // The 🔗 Link button closes the box itself (audit LINK-r1 F3).
      if (target?.closest?.("[data-link-button]")) return;
      if (boxRef.current && !boxRef.current.contains(target as Node)) onClose();
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

  const rows: Row[] = typedHref
    ? [{ href: typedHref, words: shortBlogHref(typedHref), hit: null }]
    : term
      ? GROUPS.flatMap((g) => hits.filter((h) => h.kind === g.kind)).map((h) => ({ href: h.href, words: h.title, hit: h }))
      : [];

  function choose(row: Row | undefined) {
    if (!row) return;
    applyLink(editor, row.href, row.words);
    onClose();
  }

  function close() {
    onClose();
    editor.commands.focus();
  }

  let index = -1;
  const rowButton = (row: Row) => {
    index += 1;
    const i = index;
    return (
      <button
        key={`${row.href}-${i}`}
        type="button"
        role="option"
        aria-selected={i === active}
        onMouseEnter={() => setActive(i)}
        onClick={() => choose(row)}
        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${i === active ? "bg-[#e9f0ec]" : ""}`}
      >
        <HitIcon hit={row.hit} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{row.hit ? row.hit.title : row.words}</span>
          <span className={SUB}>{row.hit ? row.hit.subtitle : /^mailto:/i.test(row.href) ? "Email address" : isLibrumHref(row.href) ? "Librum page" : "Outside website"}</span>
        </span>
      </button>
    );
  };

  return createPortal(
    <div ref={boxRef} className={POP_CLASS} style={popStyle(anchor)} role="dialog" aria-label="Link">
      <div className="border-b border-[#e7e1d3] px-3 py-2.5">
        <label className="flex items-center gap-2 rounded-[8px] border-2 border-primary bg-white px-2.5 py-[5px]">
          <span aria-hidden="true">🔍</span>
          <input
            type="text"
            value={q}
            autoFocus
            aria-label="Search Librum, or paste a web address"
            role="combobox"
            aria-controls={listId}
            aria-expanded={rows.length > 0}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, Math.max(rows.length - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(rows[active]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-0.5 outline-none"
          />
        </label>
        <div className={`mt-1.5 ${SUB}`}>Search Librum, or paste a web address (https://…)</div>
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="max-h-[60vh] overflow-y-auto">
        {typedHref && rows.map(rowButton)}
        {!typedHref &&
          term &&
          GROUPS.map((g) => {
            const group = rows.filter((r) => r.hit?.kind === g.kind);
            if (group.length === 0) return null;
            return (
              <div key={g.kind}>
                <div className="px-3 pt-2 pb-0.5 text-[11px] uppercase tracking-[.06em] text-[#6b6458]">{g.head}</div>
                {group.map(rowButton)}
              </div>
            );
          })}
        {!typedHref && term && status === "done" && rows.length === 0 && (
          <div className={`px-3 py-2 ${SUB}`}>Nothing found. You can paste a web address instead.</div>
        )}
        {!typedHref && term && status === "searching" && rows.length === 0 && <div className={`px-3 py-2 ${SUB}`}>Searching…</div>}
        {!typedHref && term && status === "error" && (
          <div role="alert" className="px-3 py-2 text-[12.5px] text-red-700">
            Search isn&apos;t working right now. You can paste a web address instead.
          </div>
        )}
      </div>
      <div className={`border-t border-[#e7e1d3] px-3 py-2 ${SUB}`}>↑ ↓ to choose · Enter to link · Esc to close</div>
    </div>,
    document.body,
  );
}

export function LinkBar({
  editor,
  anchor,
  href,
  onChange,
}: {
  editor: Editor;
  anchor: AnchorRect;
  href: string;
  onChange: () => void;
}) {
  const outside = opensInNewTab(href);
  return createPortal(
    <div
      className={POP_CLASS}
      style={popStyle(anchor)}
      role="toolbar"
      aria-label="Link"
      // Keeps the cursor in the link while staff use the bar.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
        <span className="min-w-0 flex-[1_1_160px] truncate text-primary">🔗 {shortBlogHref(href)}</span>
        {isAllowedBlogHref(href) && (
          <a href={href} target="_blank" rel="noopener noreferrer" className={PILL}>
            Open ↗
          </a>
        )}
        <button type="button" onClick={onChange} className={PILL}>
          Change
        </button>
        <button type="button" onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()} className={PILL}>
          Remove
        </button>
      </div>
      {outside && <div className={`px-2.5 pb-2 ${SUB}`}>Outside website: opens in a new tab for readers.</div>}
    </div>,
    document.body,
  );
}

// Editor-only marks, nothing is saved: the link the cursor is in gets a
// light green background, and while the 🔗 box is open the words it
// will link stay highlighted (as in the approved pictures).
const highlightKey = new PluginKey<{ from: number; to: number } | null>("blogLinkHighlight");

export function setLinkTargetHighlight(editor: Editor, range: { from: number; to: number } | null) {
  editor.view.dispatch(editor.state.tr.setMeta(highlightKey, range));
}

export const ActiveLinkHighlight = Extension.create({
  name: "blogActiveLink",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: highlightKey,
        state: {
          init: () => null,
          apply: (tr, value: { from: number; to: number } | null) => {
            const meta = tr.getMeta(highlightKey);
            if (meta !== undefined) return meta;
            return value ? { from: tr.mapping.map(value.from), to: tr.mapping.map(value.to) } : null;
          },
        },
        props: {
          decorations: (state) => {
            const target = highlightKey.getState(state);
            if (target && target.to > target.from) {
              return DecorationSet.create(state.doc, [
                Decoration.inline(target.from, target.to, { class: "bg-[#3367d1] text-white" }),
              ]);
            }
            const { selection, schema } = state;
            const type = schema.marks.link;
            if (!type || !selection.empty) return null;
            const range = getMarkRange(selection.$from, type);
            if (!range) return null;
            return DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: "bg-[#e9f0ec]" })]);
          },
        },
      }),
    ];
  },
});
