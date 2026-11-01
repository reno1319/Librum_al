import { expect, vi } from "vitest";

// W4: the preview's paragraph marks must never change the ebook. This
// file re-runs every W3 clean-up test and every converter test with a
// wrapped converter: each conversion is done a second time with the
// marks on, and everything but the preview must be identical. Each
// titled chapter is also taken out with "not a chapter" (audit F1).
vi.mock("./docx-converter", async (importOriginal) => {
  const real = await importOriginal<typeof import("./docx-converter")>();
  return {
    ...real,
    convertDocxToDocument: async (...args: Parameters<typeof real.convertDocxToDocument>) => {
      const [bytes, options, extras] = args;
      const result = await real.convertDocxToDocument(bytes, options, extras);
      if (!extras?.preview) {
        const marked = await real.convertDocxToDocument(bytes, options, { preview: true });
        if (marked.success) {
          const { preview, ...rest } = marked;
          expect(rest).toEqual(result);
          expect(preview).toHaveLength(marked.sections.length);
          // Audit F1: "Ky nuk është kapitull" on any titled chapter takes
          // exactly that chapter out (a "Kapitulli N" + title pair too).
          const titled = (r: typeof marked) => r.sections.filter((x) => x.heading).length;
          for (const s of preview!) {
            if (s.headingPara === null || !s.heading) continue;
            const not = await real.convertDocxToDocument(
              bytes,
              { ...options, notChapter: [...(options?.notChapter ?? []), s.headingPara], makeChapter: (options?.makeChapter ?? []).filter((x) => x !== s.headingPara) },
              { preview: true },
            );
            if (!not.success) throw new Error("conversion failed");
            expect(not.preview!.some((x) => x.headingPara === s.headingPara && x.heading), `"${s.heading}" still a chapter`).toBe(false);
            expect(titled(not), `"${s.heading}" not taken out`).toBe(titled(marked) - 1);
          }
        } else {
          expect(marked).toEqual(result);
        }
      }
      return result;
    },
  };
});

await import("./docx-cleanup.test");
await import("./docx-converter.test");
await import("./docx-front-matter.test");
