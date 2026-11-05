import { Fragment } from "react";
import { parseDescription, type DescriptionLine } from "@/lib/book-description";

// BD15 P8: the book page's "Rreth librit" text. The stored description
// is the small BD15 format (src/lib/book-description.ts): it is parsed
// with parseDescription and drawn as React text -- bold, italic, bullet
// and numbered lists only. No HTML from the description is ever
// rendered, so nothing an author types can become a link or a script.
function Line({ line }: { line: DescriptionLine }) {
  return (
    <>
      {line.map((run, i) => {
        let node: React.ReactNode = run.text;
        if (run.italic) node = <em>{node}</em>;
        if (run.bold) node = <strong className="font-semibold">{node}</strong>;
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </>
  );
}

export function BookDescriptionView({ stored, className }: { stored: string; className?: string }) {
  const blocks = parseDescription(stored);
  if (blocks.length === 0) return null;
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        if (block.kind === "paragraph") {
          return (
            <p key={i} className="mt-3 first:mt-0">
              {block.lines.map((line, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  <Line line={line} />
                </Fragment>
              ))}
            </p>
          );
        }
        const items = block.items.map((item, j) => (
          <li key={j}>
            <Line line={item} />
          </li>
        ));
        return block.kind === "bullets" ? (
          <ul key={i} className="mt-3 list-disc pl-6 first:mt-0">
            {items}
          </ul>
        ) : (
          <ol key={i} className="mt-3 list-decimal pl-6 first:mt-0">
            {items}
          </ol>
        );
      })}
    </div>
  );
}
