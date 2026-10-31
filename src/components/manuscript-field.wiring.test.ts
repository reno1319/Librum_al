import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// W4 audit F2/F3/F4: source-level guards that manuscript-field.tsx
// wires in the pure rules of src/lib/manuscript-approval.ts (this repo
// has no DOM test harness; see upload-wizard.wiring.test.ts). The rules
// themselves are tested in manuscript-approval.test.ts.
const source = readFileSync(path.join(__dirname, "manuscript-field.tsx"), "utf8");
const fnBody = (name: string) => {
  const start = source.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
  expect(start, name).toBeGreaterThan(0);
  const next = source.slice(start + 1).search(/\n  (?:async )?function \w+\(|\n  const \w+ = /);
  return source.slice(start, next > 0 ? start + 1 + next : undefined);
};

describe("ManuscriptField: the Save lock (answer 6a)", () => {
  it("the hidden path and onManuscriptChange come only from submittablePath()", () => {
    const body = fnBody("publishReady");
    expect(body).toContain("submittablePath(modeRef.current, tempPathRef.current, approvedRef.current)");
    expect(body).toContain('hiddenPathInputRef.current.value = submittable ?? ""');
    expect(body).toContain("onManuscriptChange?.(submittable && name ? { name } : null)");
    // Nothing else writes the hidden input.
    expect(source.match(/hiddenPathInputRef\.current\.value =/g)).toHaveLength(1);
    expect(source.match(/onManuscriptChange\?\.\(/g)).toHaveLength(1);
  });

  it("setHiddenPath goes through publishReady", () => {
    expect(fnBody("setHiddenPath")).toContain("publishReady();");
    expect(fnBody("setApproval")).toContain("publishReady();");
  });

  it("the submit handler asks shouldBlockSubmit() before the in-flight wait, and stops the event", () => {
    const handler = source.slice(source.indexOf("function handleSubmit(e: Event)"));
    const block = handler.indexOf("if (shouldBlockSubmit(modeRef.current, tempPathRef.current, approvedRef.current, pendingCountRef.current))");
    const wait = handler.indexOf("if (pendingCountRef.current === 0) return;");
    expect(block).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(block);
    const branch = handler.slice(block, wait);
    expect(branch).toContain("e.preventDefault();");
    expect(branch).toContain("e.stopImmediatePropagation();");
    expect(branch).toContain("setApproveError(APPROVE_FIRST_ERROR);");
    expect(branch).toContain("return;");
    expect(source).toContain('form.addEventListener("submit", handleSubmit, true);');
  });

  it("approval is reset on every successful conversion, on clearing the build, and when a rebuild starts", () => {
    const convert = fnBody("convertDocx");
    const success = convert.indexOf("replacePreview(parsed.previewPath);");
    expect(success).toBeGreaterThan(0);
    expect(convert.slice(success, convert.indexOf("await repackageAndFinalize(parsed.conversionId"))).toContain("resetApproval();");
    expect(fnBody("clearDocxBuild")).toContain("resetApproval();");
    expect(fnBody("resetApproval")).toContain("setApproval(false);");
    expect(fnBody("applyChoices")).toContain("setApproval(false);");
    // A new file and a mode switch both clear the build.
    expect(fnBody("handleDocxChange")).toContain("clearDocxBuild();");
    expect(fnBody("switchMode")).toContain("clearDocxBuild();");
  });
});

describe("ManuscriptField: the tick (audit F3)", () => {
  it("is disabled by approvalTickState(), fed with pending changes and the rebuild state", () => {
    expect(source).toContain("const tick = approvalTickState({ previewSeen, pendingChanges: pendingCount(choices, appliedChoices), applying });");
    expect(source).toContain("disabled={tick.disabled}");
    expect(source).toContain("{tick.reason && ");
  });

  it("a change in the preview takes back the approval", () => {
    expect(fnBody("changeChoices")).toContain("if (!approvalStillValid(approvedRef.current, pendingCount(next, appliedChoices), applying)) setApproval(false);");
    expect(source).toContain("onChoicesChange={changeChoices}");
    expect(source).not.toContain("onChoicesChange={setChoices}");
  });
});

describe("ManuscriptField: one preview download per build (audit F4)", () => {
  it("the preview downloads through the cache, which a new preview path clears", () => {
    expect(fnBody("downloadPreview")).toContain("return previewCacheRef.current.get(path);");
    expect(fnBody("replacePreview")).toContain("if (old !== path) previewCacheRef.current?.clear();");
    expect(source).toContain("download={downloadPreview}");
  });
});
