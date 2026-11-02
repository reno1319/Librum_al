import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RIGHTS_STATEMENTS } from "@/lib/rights-statements";

// F4: Add a book rendered (all three steps are mounted; only the current
// one is visible), with and without migration 20261018091237. The
// browser-only behaviour (blocking Publish book without a choice) is
// pinned at source level below and exercised in the local render.

vi.mock("../actions", () => ({ createBook: async () => undefined }));

const { UploadWizard } = await import("./upload-wizard");
const source = readFileSync(new URL("./upload-wizard.tsx", import.meta.url), "utf8");
const manuscriptSource = readFileSync(
  new URL("../../../../../components/manuscript-field.tsx", import.meta.url),
  "utf8",
);

function render(features: { penNameAvailable: boolean; rightsAvailable: boolean }, authorName = "Arben Leka") {
  return renderToStaticMarkup(
    createElement(UploadWizard, {
      series: [],
      authorName,
      authorId: "a1b2c3d4-1111-4111-8111-abcdef111111",
      paidPublishingAvailable: true,
      ...features,
    }),
  );
}

describe("Add a book with the migration applied", () => {
  const html = render({ penNameAvailable: true, rightsAvailable: true });

  it("Pseudonimi (opsional) sits directly under Title, maxLength 120, with the help naming the author", () => {
    const input = html.match(/<input[^>]*name="penName"[^>]*>/)![0];
    expect(input).toContain('maxLength="120"');
    expect(html).toContain("Pseudonimi (opsional)");
    expect(html).toContain("Lëreni bosh për të përdorur emrin tuaj si autor, Arben Leka.");
    expect(html.indexOf('name="penName"')).toBeGreaterThan(html.indexOf('name="title"'));
    expect(html.indexOf('name="penName"')).toBeLessThan(html.indexOf('name="language"'));
  });

  it("no help sentence when the author has no name yet (never 'author name, .')", () => {
    expect(render({ penNameAvailable: true, rightsAvailable: true }, "")).not.toContain("Lëreni bosh për të përdorur emrin tuaj si autor");
  });

  it("Përkthyesi (opsional) is inside Të dhëna të tjera për librin, maxLength 120", () => {
    const details = html.slice(html.indexOf("Të dhëna të tjera për librin"), html.indexOf("</details>"));
    expect(details).toContain("Përkthyesi (opsional)");
    expect(details.match(/<input[^>]*name="translator"[^>]*>/)![0]).toContain('maxLength="120"');
  });

  it("Rights: a visible legend, three radios named rightsBasis, nothing preselected", () => {
    expect(html).toContain('<legend class="mb-3 font-bold text-foreground">Të drejtat</legend>');
    const radios = html.match(/<input[^>]*name="rightsBasis"[^>]*>/g)!;
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio).not.toContain("checked");
  });

  it("the three labels equal RIGHTS_STATEMENTS code point for code point", () => {
    for (const basis of ["own_rights", "public_domain", "public_domain_original"] as const) {
      const label = html.match(new RegExp(`value="${basis}"[^>]*/><span[^>]*>([^<]*)</span>`))![1].replace(/&#x27;/g, "'");
      expect([...label].map((c) => c.codePointAt(0))).toEqual(
        [...RIGHTS_STATEMENTS[basis].text].map((c) => c.codePointAt(0)),
      );
    }
    expect(html).not.toContain("&apos;");
  });

  it("the two sentences are plain text under the bold legend (Renato 10-18: 1. b)", () => {
    for (const basis of ["own_rights", "public_domain"] as const) {
      expect(html).toMatch(new RegExp(`value="${basis}"[^>]*/><span class="text-foreground">`));
    }
  });

  it("Rights sits on step 3 between Readiness and the buttons", () => {
    const readiness = html.indexOf(">Gatishmëria</p>");
    const rights = html.indexOf(">Të drejtat</legend>");
    expect(readiness).toBeGreaterThan(html.indexOf('name="pricing"'));
    expect(rights).toBeGreaterThan(readiness);
    // The step's buttons are rendered after the step bodies.
    expect(html.indexOf(">Vazhdoni</button>")).toBeGreaterThan(rights);
  });

  it("Readiness lists the missing choice, and never says ready while it is missing", () => {
    const readiness = html.slice(html.indexOf(">Gatishmëria</p>"), html.indexOf(">Të drejtat</legend>"));
    expect(readiness).toContain("Zgjidhni të drejtat para publikimit.");
    expect(readiness).not.toContain("Gjithçka duket mirë: gati për t&#x27;u dërguar për shqyrtim.");
  });

  it("the preview card shows the author name while no pen name is typed", () => {
    const card = html.slice(html.indexOf("Si do ta shohin lexuesit"));
    expect(card).toContain("Arben Leka");
  });
});

describe("Add a book before the migration (D2/D3)", () => {
  const html = render({ penNameAvailable: false, rightsAvailable: false });

  it("no Pen name field, no Rights choice, no new readiness line", () => {
    expect(html).not.toContain('name="penName"');
    expect(html).not.toContain("Pseudonimi (opsional)");
    expect(html).not.toContain('name="rightsBasis"');
    expect(html).not.toContain(">Të drejtat</legend>");
    expect(html).not.toContain("Zgjidhni të drejtat para publikimit.");
  });

  it("never says 'ready to send for review' (the server refuses Publish without the rights table)", () => {
    expect(html).not.toContain("Gjithçka duket mirë: gati për t&#x27;u dërguar për shqyrtim.");
  });

  it("the Translator field is still there (book_contributors exists before F3)", () => {
    expect(html).toContain('name="translator"');
  });
});

describe("Add a book: the client rule (source)", () => {
  it("Publish book without a choice is blocked before submit; Ruajeni si draft never is", () => {
    const handler = source.slice(source.indexOf("function handleSubmit"), source.indexOf("// ALL-WIRING-2: readiness is previewed"));
    expect(handler).toContain("(event.nativeEvent as SubmitEvent).submitter");
    expect(handler).toContain('submitter.value === "publish"');
    expect(handler).toContain('const rightsMissing = publishing && rightsAvailable && rightsBasis === "";');
    expect(handler).toMatch(/if \(rightsMissing\) \{\s*event\.preventDefault\(\);/);
  });

  it("the radios carry the Paid / Free cards' Enter guard", () => {
    const rights = source.slice(source.indexOf('name="rightsBasis"'), source.indexOf("</fieldset>", source.indexOf('name="rightsBasis"')));
    expect(rights).toContain('if (e.key === "Enter") e.preventDefault();');
  });

  it("the byline (typed pen name, else the author name) feeds the preview card and the placeholder", () => {
    // BD3 patch 4 (1a): a typed original author comes first.
    expect(source).toContain('const byline = originalAuthor.trim() || (penNameAvailable ? penName.trim() : "") || authorName;');
    expect(source).toContain("authorName={byline}");
    expect(source).toContain("{byline && <p");
  });

  it("ManuscriptField keeps dc:creator live on the form's penName field, as it does the title", () => {
    expect(manuscriptSource).toContain('form?.elements.namedItem("penName")');
    expect(manuscriptSource).toContain("input?.value.trim() || authorName");
    expect(manuscriptSource).toContain('penNameInput?.addEventListener("input", handlePenNameInput);');
    expect(manuscriptSource).toMatch(/repackageWithTitle\(\s*conversionId,\s*liveTitleRef\.current,\s*liveAuthorRef\.current,/);
  });
});
