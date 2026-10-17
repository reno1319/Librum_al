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
    // REDESIGN STEP 5: Renato's three steps, in his own words.
    expect(steps).toEqual(["Details", "Manuscript & cover", "Price"]);
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

  it("the active state is not color-only -- it reads \"Step n of 3\" and its name is bold", () => {
    const olBlock = source.match(/<ol[\s\S]*?<\/ol>/)![0];
    expect(olBlock).toContain("Step {i + 1} of {STEPS.length}");
    expect(olBlock).toContain('<span className="text-sm font-bold text-primary">{label}</span>');
  });

  it("done steps read \"✓ Step n\" and are type=\"button\" controls back to that step; later steps are not clickable", () => {
    const olBlock = source.match(/<ol[\s\S]*?<\/ol>/)![0];
    expect(olBlock).toContain("✓ Step {i + 1}");
    const buttons = olBlock.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBe(1);
    expect(buttons[0]).toMatch(/type="button"/);
    expect(buttons[0]).toContain("onClick={() => goToDoneStep(i + 1)}");
    // The button is only rendered in the step > i + 1 (done) branch.
    expect(olBlock.indexOf("step > i + 1 ? (")).toBeLessThan(olBlock.indexOf("<button"));
    // goToDoneStep only ever moves backwards.
    expect(source).toContain("if (target >= step) return;");
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

// PR-G: the prop is `paidPublishingAvailable` now, not `payoutsEnabled`.
// The intent of these three tests is unchanged and is the point of
// keeping them: SaveButtons structurally cannot read the value, and the
// value never reaches a disabled= expression. Only the identifier moved.
describe("UploadWizard: paid-publishing context is presentational only (critical)", () => {
  it("SaveButtons (which renders both final buttons) is declared with no access to paidPublishingAvailable at all", () => {
    // SaveButtons is a module-level function, not a closure inside
    // UploadWizard -- it structurally cannot read paidPublishingAvailable
    // (a prop of UploadWizard) even if someone tried, which this asserts
    // directly rather than relying on that structural fact alone.
    const saveButtonsBlock = source.match(/function SaveButtons\(\)[\s\S]*?\n}/)![0];
    expect(saveButtonsBlock).not.toContain("paidPublishingAvailable");
    expect(saveButtonsBlock).not.toContain("payoutsEnabled");
    expect(saveButtonsBlock).not.toContain("readiness");
  });

  it("both final buttons are disabled by pending only, never by paidPublishingAvailable/readiness", () => {
    const saveButtonsBlock = source.match(/function SaveButtons\(\)[\s\S]*?\n}/)![0];
    const disabledProps = saveButtonsBlock.match(/disabled=\{[^}]*\}/g) ?? [];
    expect(disabledProps.length).toBe(2);
    for (const d of disabledProps) {
      expect(d).toBe("disabled={pending}");
    }
  });

  it("paidPublishingAvailable is used only to build the display-only readiness object, never in a disabled= expression", () => {
    const disabledLines = source.split("\n").filter((line) => line.includes("disabled="));
    for (const line of disabledLines) {
      expect(line).not.toContain("paidPublishingAvailable");
    }

    // Re-pinned, deliberately less brittle than the trailing-comma match
    // this replaced ("payoutsEnabled,\n  });"): assert the value is
    // passed into the resolvePublishReadiness() call itself, which is
    // the property that actually matters, rather than to whitespace.
    const readinessCall = source.match(/resolvePublishReadiness\(\{[\s\S]*?\n  \}\);/);
    expect(readinessCall).not.toBeNull();
    expect(readinessCall![0]).toContain("paidPublishingAvailable,");
  });

  // PR-G: the client component must never import the server-only
  // capability module. It receives the already-evaluated boolean as a
  // prop from page.tsx, and that is the only way it may arrive.
  it("never imports the server-only paid-readiness module, in ANY import form", () => {
    // Matched as an IMPORT STATEMENT, not as a bare substring -- the
    // prop's own doc comment names the module on purpose, to say why the
    // value arrives as a prop rather than an import.
    //
    // The pattern must cover BOTH forms, and the self-check below is what
    // stops it being narrowed back to the first:
    //   import { x } from "@/lib/paid-readiness";   (named / default)
    //   import "@/lib/paid-readiness";              (bare side-effect)
    // A side-effect import of a `server-only` module is exactly as fatal
    // in a client component as a named one, so a matcher that sees only
    // `from "..."` would let the real failure through.
    const IMPORT_STATEMENT = /^import\b[\s\S]*?;$/gm;

    const sideEffectSample = 'import "@/lib/paid-readiness";';
    const fromSample = 'import { canPublishPaidTitle } from "@/lib/paid-readiness";';
    expect(sideEffectSample.match(IMPORT_STATEMENT)).toEqual([sideEffectSample]);
    expect(fromSample.match(IMPORT_STATEMENT)).toEqual([fromSample]);

    const statements = source.match(IMPORT_STATEMENT) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      // The module specifier is the quoted string this statement ends on,
      // in either form.
      const specifier = statement.match(/"([^"]+)"\s*;$/)?.[1];
      expect(specifier).toBeDefined();
      expect(specifier).not.toContain("paid-readiness");
      expect(specifier).not.toContain("server-only");
    }

    expect(source).not.toMatch(/canPublishPaidTitle\s*\(/);
  });
});

describe("UploadWizard: shared pending state", () => {
  it("exactly one useFormStatus() call governs both final buttons", () => {
    expect(source.match(/useFormStatus\(\)/g)?.length).toBe(1);
  });
});

describe("UploadWizard: Language control", () => {
  it("imports and renders from the shared LANGUAGES vocabulary, not a duplicate hardcoded list", () => {
    expect(source).toContain('import { LANGUAGES } from "@/lib/languages";');
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
    expect(source).toMatch(/<select\n\s+name="language"/);
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
  it("all three step wrappers toggle a \"hidden\" class rather than unmounting", () => {
    for (let n = 1; n <= 3; n++) {
      const re = new RegExp(`className=\\{step === ${n} \\? "[^"]+" : "hidden"\\}`);
      expect(source).toMatch(re);
    }
  });
});

describe("UploadWizard: price/earnings state comes from one shared helper", () => {
  it("resolveWizardPricing() is called exactly once, and its destructured values drive the whole Price step", () => {
    expect(source.match(/resolveWizardPricing\(/g)?.length).toBe(1);
    expect(source).toContain("resolveWizardPricing({ mode: priceMode, paidPrice })");
    expect(source).not.toContain("resolveWizardPriceSummary(");
    expect(source).not.toContain("platformFeeCents(");
    expect(source).not.toMatch(/Math\.round\(Number\(price\)/);
  });

  it("shows a distinct free-book state", () => {
    expect(source).toContain("isFreeBook");
    expect(source).toContain("Free book");
  });
});

describe("UploadWizard: Price step (REDESIGN STEP 5)", () => {
  const start = source.indexOf("{/* Step 3: Price */}");
  const end = source.indexOf("</form>");
  const priceBlock = source.slice(start, end);

  it("opens on Paid with an empty price box (no hidden 0 default)", () => {
    expect(source).toContain('useState<WizardPriceMode>("paid")');
    expect(source).toMatch(/const \[paidPrice, setPaidPrice\] = useState\(""\);/);
    expect(source).not.toContain('useState("0")');
  });

  it("offers exactly two radios, Paid and Free, in one fieldset", () => {
    expect(start).toBeGreaterThan(-1);
    expect(priceBlock).toContain('["paid", "Paid"]');
    expect(priceBlock).toContain('["free", "Free"]');
    expect(priceBlock.match(/type="radio"/g)?.length).toBe(1);
    expect(priceBlock).toContain("<fieldset");
  });

  it("submits name=\"price\" from the box under Paid and a fixed 0 under Free -- never both", () => {
    expect(priceBlock.match(/name="price"/g)?.length).toBe(2);
    expect(priceBlock).toContain('<input type="hidden" name="price" value="0" />');
    const paidBranch = priceBlock.slice(
      priceBlock.indexOf('{priceMode === "paid" ? ('),
      priceBlock.indexOf('<input type="hidden" name="price" value="0" />'),
    );
    expect(paidBranch).toContain('name="price"');
    expect(paidBranch).toContain("value={paidPrice}");
  });

  it("Enter on the Paid/Free radios or in the price box never submits the form", () => {
    const radio = priceBlock.match(/<input\s+type="radio"[\s\S]*?\/>/)![0];
    const priceBox = priceBlock.match(/<input\s+ref=\{priceInputRef\}[\s\S]*?\/>/)![0];
    for (const input of [radio, priceBox]) {
      expect(input).toContain('if (e.key === "Enter") e.preventDefault();');
    }
  });

  it("keeps the existing \"Price (ALL)\" label; the ALL suffix is decoration only", () => {
    expect(priceBlock).toContain("Price (ALL)");
    expect(priceBlock).toMatch(/aria-hidden="true"[\s\S]{0,120}>\s*ALL\s*</);
  });

  it("an invalid paid price blocks both final buttons in the submit handler, with Q7's wording", () => {
    expect(source).toContain("<form action={createBook} onSubmit={handleSubmit}");
    const handler = source.match(/function handleSubmit\([\s\S]*?\n  }/)![0];
    expect(handler).toContain("if (!pricing.canSubmit) {");
    expect(handler).toContain("event.preventDefault();");
    expect(handler).toContain("setStepError(PAID_PRICE_ERROR);");
    expect(source).toContain(
      "const PAID_PRICE_ERROR = `Enter a price in lek: a whole number from ${MINIMUM_PAID_CATALOG_PRICE_ALL} to ${MAXIMUM_CATALOG_PRICE_ALL}.`;",
    );
  });

  it("no sentence still offers \"0 for a free ebook\" or \"(0, or\"", () => {
    expect(source).not.toContain("0 for a free ebook");
    expect(source).not.toContain("(0, or");
  });

  it("renders the readiness block, without the unreachable missing-price line, and no Review summary", () => {
    expect(priceBlock).toContain("Readiness");
    expect(priceBlock).toContain("readiness.paidPublishingBlocked");
    expect(priceBlock).toContain("Looks good — ready to publish.");
    expect(source).not.toContain("Set a price in lek on the previous step");
    expect(source).not.toContain("Double check the basics below");
    expect(source).not.toContain("Review & Publish");
  });

  it("the preview card uses the book card's own price label and the real cover/title/author", () => {
    expect(priceBlock).toContain("How readers will see it");
    expect(priceBlock).toContain("formatCatalogPriceLabel(priceAll)");
    expect(priceBlock).toContain("cover.previewUrl");
    expect(priceBlock).toContain("{authorName}");
    expect(priceBlock).toContain("{title.trim() && (");
    // No price line at all while the price is not valid.
    expect(priceBlock).toContain("{priceValid && (");
  });
});

describe("UploadWizard: no server/other-surface scope creep", () => {
  it("this pass never imports from or references the server actions file's internals beyond the existing createBook() import", () => {
    const importLines = source.split("\n").filter((l) => l.startsWith("import"));
    const actionsImport = importLines.find((l) => l.includes('"../actions"'));
    expect(actionsImport).toBe('import { createBook } from "../actions";');
  });
});
