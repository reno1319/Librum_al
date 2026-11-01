import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// BD5 (3a): the browser-side expiry check in the manuscript and cover
// fields, pinned at source level (the test environment has no DOM; the
// decision itself is unit-tested in src/lib/temp-upload-expiry.test.ts).
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const fields = {
  manuscript: read("./manuscript-field.tsx"),
  cover: read("./cover-field.tsx"),
};
const wizard = read("../app/(public)/dashboard/books/new/upload-wizard.tsx");

function submitHandler(source: string): string {
  const start = source.indexOf("function handleSubmit(e: Event)");
  return source.slice(start, source.indexOf('form.addEventListener("submit", handleSubmit, true)', start));
}

describe.each(Object.entries(fields))("%s field", (_name, source) => {
  it("stops a Save with an expired upload first, before anything is sent", () => {
    const handler = submitHandler(source);
    const check = handler.indexOf("checkUploadAge();");
    const block = handler.indexOf("if (expiredNoticeRef.current) {");
    expect(check).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(check);
    const blockBody = handler.slice(block, handler.indexOf("return;", block));
    expect(blockBody).toContain("e.preventDefault();");
    expect(blockBody).toContain("e.stopImmediatePropagation();");
    expect(blockBody).toContain("onUploadExpiredRef.current?.();");
    expect(blockBody).toContain("expiredNoticeRef.current = false;");
    // It runs before every other check in the handler.
    expect(handler.slice(0, check)).not.toMatch(/pendingCountRef|shouldBlockSubmit/);
  });

  it("stamps the upload time only when a new temporary path is set", () => {
    expect(source).toContain("if (path === null) uploadedAtRef.current = null;");
    expect(source).toContain("else if (path !== tempPathRef.current) uploadedAtRef.current = Date.now();");
  });

  it("clears the upload, shows the message and empties the picker on expiry", () => {
    const expire = source.slice(source.indexOf("function expireUpload()"), source.indexOf("function checkUploadAge()"));
    // Audit r1 F4: the stored file is left to the nightly job, since a
    // Save sent just before the limit may still be reading it.
    expect(expire).not.toContain("removeTempObject");
    expect(expire).toContain("setErrorMessage(TEMP_UPLOAD_EXPIRED_MESSAGE);");
    expect(expire).toContain('setStatus("error");');
    expect(expire).toContain("setPickerKey((key) => key + 1);");
    expect(expire).toContain("expiredNoticeRef.current = true;");
    expect(source).toMatch(/type="file"\s+accept="[^"]+"\s+key=\{pickerKey\}/);
  });

  it("re-checks every minute and when the tab becomes visible", () => {
    expect(source).toContain("window.setInterval(checkUploadAge, TEMP_UPLOAD_CHECK_INTERVAL_MS)");
    expect(source).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(source).toContain("window.clearInterval(timer)");
  });
});

it("the manuscript field also drops the Word preview copy on expiry", () => {
  const source = fields.manuscript;
  const expire = source.slice(source.indexOf("function expireUpload()"), source.indexOf("function checkUploadAge()"));
  expect(expire).toContain("clearDocxBuild();");
  expect(source.match(/key=\{pickerKey\}/g)).toHaveLength(2);
});

it("the Add a book wizard goes back to the Files step when a Save is stopped", () => {
  expect(wizard).toContain("onUploadExpired={goToFilesStep}");
  expect(wizard.match(/onUploadExpired=\{goToFilesStep\}/g)).toHaveLength(2);
  expect(wizard).toMatch(/function goToFilesStep\(\) \{\s+setStep\(2\);\s+\}/);
});
