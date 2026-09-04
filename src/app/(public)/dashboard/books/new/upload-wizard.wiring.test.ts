import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 PUBLISHING-UX-1 PART C FINAL-VERIFICATION PASS: this
// codebase deliberately has no React DOM-testing-library harness (see
// this repo's own comment in [id]/edit/page.test.ts for why -- live
// verification is preferred for real rendering behavior). The
// pure-logic helpers in wizard-validation.ts already get direct unit
// coverage; what's missing is proof that upload-wizard.tsx's actual
// JSX WIRES those helpers in, rather than merely defining them beside
// unused/parallel logic. These are source-level regression guards, the
// same convention already established by edit/page.test.ts's own
// "never passes an inline function prop" test -- reading the real
// upload-wizard.tsx file and asserting on its actual text, not a
// re-implementation of it.
const source = readFileSync(path.join(__dirname, "upload-wizard.tsx"), "utf8");
const coverFieldSource = readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "..", "components", "cover-field.tsx"),
  "utf8",
);
const manuscriptFieldSource = readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "..", "components", "manuscript-field.tsx"),
  "utf8",
);

describe("UploadWizard: actual step order and indicator wiring", () => {
  it("declares STEPS in the exact required order", () => {
    const match = source.match(/const STEPS = \[([^\]]+)\];/);
    expect(match).not.toBeNull();
    const steps = match![1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    expect(steps).toEqual(["Book Details", "Cover & Manuscript", "Price & Earnings", "Review & Publish"]);
  });

  it("the rendered step indicator (<ol>...STEPS.map...) consumes that same STEPS array -- not a parallel unused constant", () => {
    const olBlock = source.match(/<ol[\s\S]*?<\/ol>/);
    expect(olBlock).not.toBeNull();
    expect(olBlock![0]).toContain("{STEPS.map(");
    // Only one STEPS declaration exists in the whole file -- nothing
    // else could plausibly be the "real" one.
    expect(source.match(/const STEPS = /g)?.length).toBe(1);
  });
});

describe("UploadWizard: aria-current on the active step", () => {
  it("uses the literal aria-current=\"step\" value, driven by the real step state", () => {
    const olBlock = source.match(/<ol[\s\S]*?<\/ol>/)![0];
    expect(olBlock).toContain('aria-current={step === i + 1 ? "step" : undefined}');
  });

  it("the active state is not color-only -- a font-weight change accompanies the color change", () => {
    const olBlock = source.match(/<ol[\s\S]*?<\/ol>/)![0];
    const classNameMatch = olBlock.match(/className=\{step === i \+ 1 \? "([^"]+)" : undefined\}/);
    expect(classNameMatch).not.toBeNull();
    // font-semibold (a weight change) alongside text-primary (a color
    // change) -- removing color alone would still leave a visible
    // difference for a non-color-perception reader.
    expect(classNameMatch![1]).toContain("font-semibold");
    expect(classNameMatch![1]).toContain("text-primary");
  });
});

describe("UploadWizard: one-form architecture", () => {
  it("contains exactly one <form>, using createBook", () => {
    const formOpenTags = source.match(/<form\b/g) ?? [];
    expect(formOpenTags.length).toBe(1);
    expect(source).toContain("<form action={createBook}");
  });

  it("Back and Next are type=\"button\", never submit controls", () => {
    const backButton = source.match(/<button[\s\S]*?onClick=\{goBack\}[\s\S]*?<\/button>/);
    const nextButton = source.match(/<button[\s\S]*?onClick=\{goNext\}[\s\S]*?<\/button>/);
    expect(backButton).not.toBeNull();
    expect(nextButton).not.toBeNull();
    expect(backButton![0]).toMatch(/type="button"/);
    expect(nextButton![0]).toMatch(/type="button"/);
  });

  it("the final-step actions (Save as draft / Publish book) are real submit controls", () => {
    const saveButtonsBlock = source.match(/function SaveButtons\(\)[\s\S]*?\n}/)![0];
    const submitButtons = saveButtonsBlock.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(submitButtons.length).toBe(2);
    for (const btn of submitButtons) {
      expect(btn).toMatch(/type="submit"/);
    }
  });
});

describe("UploadWizard: native intent controls (critical)", () => {
  const saveButtonsBlock = source.match(/function SaveButtons\(\)[\s\S]*?\n}/)![0];

  it("Save as draft submits name=\"intent\" value=\"draft\"", () => {
    expect(saveButtonsBlock).toMatch(/name="intent"\s*\n\s*value="draft"/);
    expect(saveButtonsBlock).toContain("Save as draft");
  });

  it("Publish book submits name=\"intent\" value=\"publish\"", () => {
    expect(saveButtonsBlock).toMatch(/name="intent"\s*\n\s*value="publish"/);
    expect(saveButtonsBlock).toContain("Publish book");
  });

  it("there is no hidden mutable intent field anywhere in the form", () => {
    expect(source).not.toMatch(/type="hidden"[^>]*name="intent"/);
    expect(source).not.toMatch(/name="intent"[^>]*type="hidden"/);
  });

  it("there is no separate React intent state or onClick that mutates intent before submit", () => {
    expect(source).not.toMatch(/const \[\s*intent\s*,/);
    expect(source).not.toMatch(/setIntent/);
    // Every onClick in the file is goBack/goNext (step navigation) --
    // neither reads or writes anything named "intent".
    const onClicks = source.match(/onClick=\{[^}]*\}/g) ?? [];
    for (const oc of onClicks) {
      expect(oc.toLowerCase()).not.toContain("intent");
    }
  });
});

describe("UploadWizard: payout context is presentational only (critical)", () => {
  it("SaveButtons (which renders both final buttons) is declared with no access to payoutsEnabled at all", () => {
    // SaveButtons is a module-level function, not a closure inside
    // UploadWizard -- it structurally cannot read payoutsEnabled (a
    // prop of UploadWizard) even if someone tried, which this asserts
    // directly rather than relying on that structural fact alone.
    const saveButtonsBlock = source.match(/function SaveButtons\(\)[\s\S]*?\n}/)![0];
    expect(saveButtonsBlock).not.toContain("payoutsEnabled");
    expect(saveButtonsBlock).not.toContain("readiness");
  });

  it("both final buttons are disabled by pending only, never by payoutsEnabled/readiness", () => {
    const saveButtonsBlock = source.match(/function SaveButtons\(\)[\s\S]*?\n}/)![0];
    const disabledProps = saveButtonsBlock.match(/disabled=\{[^}]*\}/g) ?? [];
    expect(disabledProps.length).toBe(2);
    for (const d of disabledProps) {
      expect(d).toBe("disabled={pending}");
    }
  });

  it("payoutsEnabled is used only to build the display-only readiness object, never in a disabled= expression", () => {
    const disabledLines = source.split("\n").filter((line) => line.includes("disabled="));
    for (const line of disabledLines) {
      expect(line).not.toContain("payoutsEnabled");
    }
    expect(source).toContain("payoutsEnabled,\n  });");
  });
});

describe("UploadWizard: shared pending state", () => {
  it("exactly one useFormStatus() call governs both final buttons", () => {
    expect(source.match(/useFormStatus\(\)/g)?.length).toBe(1);
  });
});

describe("UploadWizard: Language control", () => {
  it("imports and renders from the shared LANGUAGES vocabulary, not a duplicate hardcoded list", () => {
    expect(source).toContain('import { LANGUAGES, getLanguageLabel } from "@/lib/languages";');
    const languageSelect = source.match(/<select\s+name="language"[\s\S]*?<\/select>/);
    expect(languageSelect).not.toBeNull();
    expect(languageSelect![0]).toContain("{LANGUAGES.map(");
    // No second, independently-hardcoded language array anywhere in
    // this file -- a duplicate list would look like a { code: ...,
    // label: ... } object literal, the exact shape LANGUAGES itself
    // uses in languages.ts. None of that shape exists here.
    expect(source).not.toMatch(/code:\s*["']/);
    expect(source.match(/LANGUAGES\.map\(/g)?.length).toBe(1);
  });

  it("defaults to \"sq\" (Albanian)", () => {
    expect(source).toContain('useState("sq")');
    const languageStateLine = source.split("\n").find((l) => l.includes("[language, setLanguage]"));
    expect(languageStateLine).toContain('useState("sq")');
  });

  it("submits name=\"language\"", () => {
    expect(source).toContain('<select\n            name="language"');
  });
});

describe("UploadWizard: Step 1 gate uses the tested helper, required vs optional matches spec", () => {
  it("goNext's step-1 check calls canAdvanceFromBookDetails with the real field state", () => {
    expect(source).toContain("canAdvanceFromBookDetails({ title, language, genre })");
  });

  it("title, language, and genre are the only step-1 fields marked required", () => {
    const titleBlock = source.match(/Title\s*<input[\s\S]*?\/>/)![0];
    const languageBlock = source.match(/<select\s+name="language"[\s\S]*?<\/select>/)![0];
    const genreBlock = source.match(/<select\s+name="genre"[\s\S]*?<\/select>/)![0];
    expect(titleBlock).toContain("required");
    expect(languageBlock).toContain("required");
    expect(genreBlock).toContain("required");
  });

  it.each(["subtitle", "isbn", "publisher", "edition", "originalPublicationDate", "keywords"])(
    "%s is never marked required",
    (fieldName) => {
      const fieldBlock = source.match(new RegExp(`name="${fieldName}"[\\s\\S]{0,400}?/>`));
      expect(fieldBlock).not.toBeNull();
      expect(fieldBlock![0]).not.toContain("required");
    },
  );

  it("series selection is never marked required", () => {
    expect(source).not.toMatch(/name="seriesId"[^>]*required/);
    expect(source).not.toMatch(/name="seriesPosition"[^>]*required/);
  });
});

describe("UploadWizard: Step 2 (Cover & Manuscript) gate and ready-state copy", () => {
  it("goNext's step-2 check calls canAdvanceFromFiles with real cover/manuscript readiness", () => {
    expect(source).toContain(
      "canAdvanceFromFiles({ coverReady: !!cover, manuscriptReady: !!manuscript })",
    );
  });

  it("CoverField shows persistent \"Cover ready\" text and relabels to \"Replace cover\" once ready", () => {
    expect(coverFieldSource).toContain("Cover ready");
    expect(coverFieldSource).toContain("Replace cover");
  });

  it("ManuscriptField shows persistent \"Manuscript ready\" text and relabels to \"Replace manuscript\" once ready", () => {
    expect(manuscriptFieldSource).toContain("Manuscript ready");
    expect(manuscriptFieldSource).toContain("Replace manuscript");
  });
});

describe("UploadWizard: steps remain mounted (hidden via class, never conditionally unmounted)", () => {
  it("all four step wrappers toggle a \"hidden\" class rather than unmounting", () => {
    for (let n = 1; n <= 4; n++) {
      const re = new RegExp(`className=\\{step === ${n} \\? "[^"]+" : "hidden"\\}`);
      expect(source).toMatch(re);
    }
  });
});

describe("UploadWizard: price/earnings state comes from one shared helper", () => {
  it("resolveWizardPriceSummary() is called exactly once, and its destructured values drive both Step 3 and Review", () => {
    expect(source.match(/resolveWizardPriceSummary\(/g)?.length).toBe(1);
    expect(source).not.toContain("platformFeeCents(");
    expect(source).not.toMatch(/Math\.round\(Number\(price\)/);
  });

  it("shows a distinct free-book state", () => {
    expect(source).toContain("isFreeBook");
    expect(source).toContain("Free book");
  });
});

describe("UploadWizard: Review renders live state, no server/other-surface scope creep", () => {
  it("Review shows the real title/language-label/genre/cover/manuscript/readiness state", () => {
    const start = source.indexOf("{/* Step 4: Review & Publish */}");
    const end = source.indexOf('<div className="flex justify-between gap-3">');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const reviewBlock = source.slice(start, end);
    expect(reviewBlock).toContain("{title ||");
    expect(reviewBlock).toContain("getLanguageLabel(language)");
    expect(reviewBlock).toContain("{genre ||");
    expect(reviewBlock).toContain("cover.previewUrl");
    expect(reviewBlock).toContain("manuscript?.name");
    expect(reviewBlock).toContain("readiness.");
  });

  it("this pass never imports from or references the server actions file's internals beyond the existing createBook() import", () => {
    const importLines = source.split("\n").filter((l) => l.startsWith("import"));
    const actionsImport = importLines.find((l) => l.includes('"../actions"'));
    expect(actionsImport).toBe('import { createBook } from "../actions";');
  });
});
