"use client";

import { useRef, useState } from "react";
import {
  DESCRIPTION_MAX_CHARACTERS,
  descriptionCharacterCount,
  descriptionFromEditorDom,
  descriptionToEditorHtml,
  parseDescription,
  type EditorNode,
} from "@/lib/book-description";

// BD15 P2: the description box with bold, italic and the two lists
// (PLAN-BD15-r1 §2.3). It is a contenteditable box filled once from the
// stored text with escaped HTML of five tags (descriptionToEditorHtml),
// and read back after every change into the stored format
// (descriptionFromEditorDom), which goes in the hidden field the form
// submits. HTML never leaves the browser: the server receives the small
// text format and normalizes it again. A paste is inserted as plain text.

const TOOLS = [
  { command: "bold", label: "B", name: "E trashë", className: "font-bold" },
  { command: "italic", label: "I", name: "E pjerrët", className: "italic" },
  { command: "insertUnorderedList", label: "• Listë", name: "Listë me pika", className: "" },
  { command: "insertOrderedList", label: "1. Listë", name: "Listë me numra", className: "" },
] as const;

function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function DescriptionEditor({
  name,
  initialValue,
  labelId,
  describedBy,
  invalid,
  onChange,
}: {
  name: string;
  initialValue: string;
  labelId: string;
  describedBy?: string;
  invalid?: boolean;
  onChange?: (value: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Filled once; React never re-renders the box's content after that.
  const [initialHtml] = useState(() => descriptionToEditorHtml(initialValue));
  const [value, setValue] = useState(() => {
    const blocks = parseDescription(initialValue);
    return { stored: initialValue, count: descriptionCharacterCount(blocks) };
  });

  const read = () => {
    const box = boxRef.current;
    if (!box) return;
    const stored = descriptionFromEditorDom(box as unknown as EditorNode);
    setValue({ stored, count: descriptionCharacterCount(parseDescription(stored)) });
    onChange?.(stored);
  };

  const run = (command: (typeof TOOLS)[number]["command"]) => {
    boxRef.current?.focus();
    // execCommand is old, but every browser Librum supports still runs
    // these four, and the result is read back through the same filter.
    document.execCommand(command);
    read();
  };

  const over = value.count > DESCRIPTION_MAX_CHARACTERS;

  return (
    <div className="flex flex-col gap-1">
      <div role="toolbar" aria-label="Formati i përshkrimit" className="flex flex-wrap gap-1">
        {TOOLS.map((tool) => (
          <button
            key={tool.command}
            type="button"
            aria-label={tool.name}
            title={tool.name}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(tool.command)}
            className={`focus-ring min-h-9 min-w-9 rounded-control border border-control bg-surface px-2 text-sm hover:bg-surface-hover ${tool.className}`}
          >
            {tool.label}
          </button>
        ))}
      </div>
      <div
        ref={boxRef}
        role="textbox"
        aria-multiline="true"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={invalid || over ? true : undefined}
        contentEditable
        suppressContentEditableWarning
        onInput={read}
        onBlur={read}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, text);
          read();
        }}
        className={`focus-ring min-h-40 rounded-control border bg-surface px-3 py-2 text-base leading-relaxed sm:text-sm [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 ${
          invalid || over ? "border-red-700" : "border-control"
        }`}
        dangerouslySetInnerHTML={{ __html: initialHtml }}
      />
      <input type="hidden" name={name} value={value.stored} />
      <span className={`text-sm ${over ? "font-medium text-red-800" : "text-muted"}`} aria-live="polite">
        {groupThousands(value.count)} / {groupThousands(DESCRIPTION_MAX_CHARACTERS)} karaktere
      </span>
    </div>
  );
}
