import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";

// BUNDLE-DELETE-SAFETY-1: every bundle row's Delete asks for
// confirmation naming that row's exact title, and calls deleteBundle
// exactly once with that row's own id only after the author accepts.
// Canceling calls nothing. The rendered page gives each row its own
// id and title, and Edit, Publish and Unpublish keep targeting the row
// they sit on.

const mockDeleteBundle = vi.fn(async (bundleId: string) => {
  void bundleId;
});
const mockPublishBundle = vi.fn(async (bundleId: string) => {
  void bundleId;
});
const mockUnpublishBundle = vi.fn(async (bundleId: string) => {
  void bundleId;
});
vi.mock("./actions", () => ({
  createBundle: vi.fn(),
  publishBundle: mockPublishBundle,
  unpublishBundle: mockUnpublishBundle,
  deleteBundle: mockDeleteBundle,
}));

const AUTHOR_ID = "a0000000-0000-4000-8000-00000000000a";
const FIXTURE = { id: "b0000000-0000-4000-8000-0000000000f1", title: "Fixture Bundle", status: "published", price_all: 0 };
const DISPOSABLE = {
  id: "b0000000-0000-4000-8000-0000000000d1",
  title: "P13 DISPOSABLE 20260926-1415Z EDITED",
  status: "draft",
  price_all: 199,
};

// A Supabase query chain for the page's three reads: every builder
// method returns the chain, and awaiting it yields the table's rows.
function makePageClient(bundles: unknown[]) {
  const rowsByTable: Record<string, unknown[]> = {
    books: [
      { id: "c0000000-0000-4000-8000-000000000001", title: "Book One" },
      { id: "c0000000-0000-4000-8000-000000000002", title: "Book Two" },
    ],
    bundles,
    bundle_books: [],
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: AUTHOR_ID } } }) },
    from(table: string) {
      const result = { data: rowsByTable[table], error: null };
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      for (const method of ["select", "eq", "order", "in", "returns"]) {
        chain[method] = () => chain;
      }
      for (const method of ["insert", "update", "delete", "upsert"]) {
        chain[method] = () => {
          throw new Error(`page wrote ${table}`);
        };
      }
      return chain;
    },
  };
}

let pageBundles: unknown[] = [];
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => makePageClient(pageBundles) }));

const { DeleteBundleButton, bundleDeleteConfirmationMessage } = await import("./delete-bundle-button");
const { default: BundlesPage } = await import("./page");
const { redirect: realRedirect } = await import("next/navigation");

type ButtonProps = {
  type: string;
  disabled: boolean;
  "aria-busy"?: boolean;
  "aria-label": string;
  onClick: () => void;
  children: ReactNode;
};
type Target = { bundleId: string; title: string; status: string };
type Instance = InstanceType<typeof DeleteBundleButton>;

// Mounts one button outside React's renderer: the instance gets an
// updater that applies setState synchronously, which is all a class
// component needs. `click()` fires the rendered button's own onClick,
// and `view()` is what React would render now. Dependencies stay the
// browser defaults (window.confirm + the mocked deleteBundle) unless a
// test injects its own.
function mount(target: Target, dependencies?: Instance["dependencies"]) {
  const instance = new DeleteBundleButton(target);
  (instance as unknown as { updater: unknown }).updater = {
    isMounted: () => true,
    enqueueSetState(inst: Instance, partial: unknown) {
      const next =
        typeof partial === "function" ? (partial as (s: Instance["state"]) => object)(inst.state) : partial;
      inst.state = { ...inst.state, ...(next as object) };
    },
    enqueueReplaceState() {},
    enqueueForceUpdate() {},
  };
  if (dependencies) instance.dependencies = dependencies;
  const view = () => instance.render() as ReactElement<ButtonProps>;
  return { instance, view, click: () => view().props.onClick() };
}

// A deleteBundle stand-in whose calls stay pending until the test settles them.
function deferredAction() {
  const settlers: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const action = vi.fn(
    (bundleId: string) =>
      new Promise<void>((resolve, reject) => {
        void bundleId;
        settlers.push({ resolve, reject });
      }),
  );
  return { action, settlers };
}

// Lets the transition's `await` and `finally` run.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let confirmSpy: ReturnType<typeof vi.fn>;
function stubConfirm(answer: unknown) {
  confirmSpy = vi.fn(() => answer);
  vi.stubGlobal("window", { confirm: confirmSpy });
}

// React reports an error thrown from an async transition as a global
// error; Node has no reportError, so it arrives as an uncaught exception.
// The rejection tests below collect those instead of failing the run.
let reportedErrors: unknown[];
function onUncaught(error: unknown) {
  reportedErrors.push(error);
}

beforeEach(() => {
  mockDeleteBundle.mockClear();
  mockPublishBundle.mockClear();
  mockUnpublishBundle.mockClear();
  pageBundles = [FIXTURE, DISPOSABLE];
  reportedErrors = [];
  process.on("uncaughtException", onUncaught);
});
afterEach(() => {
  process.off("uncaughtException", onUncaught);
  vi.unstubAllGlobals();
});

const DISPOSABLE_TARGET: Target = { bundleId: DISPOSABLE.id, title: DISPOSABLE.title, status: DISPOSABLE.status };
const FIXTURE_TARGET: Target = { bundleId: FIXTURE.id, title: FIXTURE.title, status: FIXTURE.status };

describe("DeleteBundleButton: explicit confirmation", () => {
  it("renders a plain, enabled button (not a submit) whose accessible name names the exact bundle", () => {
    const html = renderToStaticMarkup(createElement(DeleteBundleButton, DISPOSABLE_TARGET));
    expect(html).toContain('type="button"');
    expect(html).toContain(`aria-label="Delete bundle “${DISPOSABLE.title}”"`);
    expect(html).toContain(">Delete</button>");
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(DISPOSABLE.id);
  });

  it("the confirmation shows the exact title, the bundle's state, and that it cannot be undone", () => {
    expect(bundleDeleteConfirmationMessage({ title: DISPOSABLE.title, status: "draft" })).toBe(
      `Delete the draft bundle "${DISPOSABLE.title}"?\n\nThis can't be undone. The books in it are not deleted.`,
    );
    expect(bundleDeleteConfirmationMessage({ title: FIXTURE.title, status: "published" })).toBe(
      `Delete the published bundle "Fixture Bundle"?\n\nThis can't be undone. The books in it are not deleted.`,
    );
    expect(bundleDeleteConfirmationMessage({ title: "T", status: "something" })).toContain('Delete the bundle "T"?');
  });

  it("canceling calls no action and takes no lock", async () => {
    stubConfirm(false);
    const button = mount(DISPOSABLE_TARGET);
    button.click();
    await flush();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockDeleteBundle).not.toHaveBeenCalled();
    expect(button.instance.isLocked()).toBe(false);
    expect(button.view().props.disabled).toBe(false);
  });

  it("a suppressed or non-boolean dialog answer counts as cancel and takes no lock", async () => {
    for (const answer of [undefined, null, "true", 1]) {
      stubConfirm(answer);
      const button = mount(DISPOSABLE_TARGET);
      button.click();
      expect(button.instance.isLocked()).toBe(false);
    }
    await flush();
    expect(mockDeleteBundle).not.toHaveBeenCalled();
  });

  it("accepting calls the browser-wired action exactly once, with this bundle's id only, after the dialog", async () => {
    stubConfirm(true);
    mount(DISPOSABLE_TARGET).click();
    await flush();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain(`"${DISPOSABLE.title}"`);
    expect(mockDeleteBundle.mock.calls).toEqual([[DISPOSABLE.id]]);
    expect(confirmSpy.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteBundle.mock.invocationCallOrder[0]);
  });
});

describe("DeleteBundleButton: single-flight per mounted button", () => {
  it("clicks while the accepted deletion is unresolved open no dialog and call no action", async () => {
    const confirm = vi.fn(() => true);
    const { action, settlers } = deferredAction();
    const button = mount(DISPOSABLE_TARGET, { confirm, action });

    button.click();
    button.click();
    await flush();
    button.click();
    button.view().props.onClick();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(action.mock.calls).toEqual([[DISPOSABLE.id]]);
    expect(settlers).toHaveLength(1);
  });

  it("the lock and the pending state are taken before the action is dispatched", () => {
    const confirm = vi.fn(() => true);
    const ref: { button?: ReturnType<typeof mount> } = {};
    const observed: { locked: boolean; disabled: boolean; reentrantCalled: boolean }[] = [];
    const action = vi.fn((bundleId: string) => {
      void bundleId;
      // A click arriving at the very moment of dispatch must already be refused.
      const reentrantCalled = ref.button!.instance.requestDeletion();
      observed.push({
        locked: ref.button!.instance.isLocked(),
        disabled: ref.button!.view().props.disabled,
        reentrantCalled,
      });
      return new Promise<void>(() => {});
    });
    const button = mount(DISPOSABLE_TARGET, { confirm, action });
    ref.button = button;

    expect(button.instance.requestDeletion()).toBe(true);
    expect(observed).toEqual([{ locked: true, disabled: true, reentrantCalled: false }]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("while pending, only this button is disabled, busy and labelled as deleting", () => {
    const { action } = deferredAction();
    const disposable = mount(DISPOSABLE_TARGET, { confirm: () => true, action });
    const fixture = mount(FIXTURE_TARGET, { confirm: () => true, action });

    disposable.click();

    const pendingView = disposable.view();
    expect(pendingView.props.disabled).toBe(true);
    expect(pendingView.props["aria-busy"]).toBe(true);
    expect(pendingView.props.children).toBe("Deleting…");
    expect(pendingView.props["aria-label"]).toBe(`Deleting bundle “${DISPOSABLE.title}”…`);
    const pendingHtml = renderToStaticMarkup(pendingView);
    expect(pendingHtml).toContain('disabled=""');
    expect(pendingHtml).toContain('aria-busy="true"');
    expect(pendingHtml).toContain(">Deleting…</button>");

    const idleView = fixture.view();
    expect(idleView.props.disabled).toBe(false);
    expect(idleView.props["aria-busy"]).toBeUndefined();
    expect(idleView.props.children).toBe("Delete");
    expect(fixture.instance.isLocked()).toBe(false);
  });

  it("two rows have independent locks: a pending row does not block another row's own deletion", async () => {
    const confirm = vi.fn(() => true);
    const { action, settlers } = deferredAction();
    const disposable = mount(DISPOSABLE_TARGET, { confirm, action });
    const fixture = mount(FIXTURE_TARGET, { confirm, action });

    disposable.click();
    fixture.click();
    disposable.click();
    fixture.click();
    await flush();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(action.mock.calls).toEqual([[DISPOSABLE.id], [FIXTURE.id]]);

    settlers[0].resolve();
    await flush();
    expect(disposable.instance.isLocked()).toBe(false);
    expect(fixture.instance.isLocked()).toBe(true);
    expect(fixture.view().props.disabled).toBe(true);
  });

  it("cancel, then a later confirmation, deletes once", async () => {
    const answers = [false, true];
    const confirm = vi.fn(() => answers.shift() === true);
    const { action } = deferredAction();
    const button = mount(DISPOSABLE_TARGET, { confirm, action });

    button.click();
    expect(button.instance.isLocked()).toBe(false);
    expect(action).not.toHaveBeenCalled();

    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(action.mock.calls).toEqual([[DISPOSABLE.id]]);
    expect(button.instance.isLocked()).toBe(true);
  });

  it("an action that completes without navigating restores a deliberate retry", async () => {
    const confirm = vi.fn(() => true);
    const { action, settlers } = deferredAction();
    const button = mount(DISPOSABLE_TARGET, { confirm, action });

    button.click();
    await flush();
    expect(button.view().props.disabled).toBe(true);

    settlers[0].resolve();
    await flush();
    expect(button.instance.isLocked()).toBe(false);
    expect(button.view().props.disabled).toBe(false);
    expect(button.view().props.children).toBe("Delete");

    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(action.mock.calls).toEqual([[DISPOSABLE.id], [DISPOSABLE.id]]);
  });

  it("an action that rejects restores a deliberate retry, and the error is not swallowed", async () => {
    const confirm = vi.fn(() => true);
    const { action, settlers } = deferredAction();
    const button = mount(DISPOSABLE_TARGET, { confirm, action });
    const failure = new Error("network lost");

    button.click();
    settlers[0].reject(failure);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(button.instance.isLocked()).toBe(false);
    expect(button.view().props.disabled).toBe(false);
    expect(reportedErrors).toContain(failure);

    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("the lock is held until Next's redirect rejection arrives, then released; the redirect is passed on", async () => {
    const confirm = vi.fn(() => true);
    const { action, settlers } = deferredAction();
    const button = mount(DISPOSABLE_TARGET, { confirm, action });
    let redirectError: unknown;
    try {
      realRedirect("/dashboard/bundles?success=Bundle+deleted");
    } catch (e) {
      redirectError = e;
    }

    button.click();
    await flush();
    button.click();
    expect(button.instance.isLocked()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);

    settlers[0].reject(redirectError);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.instance.isLocked()).toBe(false);
    expect(reportedErrors).toContain(redirectError);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

// Walks a rendered-but-not-yet-mounted element tree (the page's own
// output) and returns every element it contains.
function collectElements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    collectElements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

async function renderPageTree() {
  return (await BundlesPage({ searchParams: Promise.resolve({}) })) as ReactElement;
}

function bundleRows(tree: ReactElement) {
  return collectElements(tree).filter((el) => el.type === "li");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

describe("BundlesPage: every row's controls target that row", () => {
  it("each row's delete control carries its own exact id and title, and no two rows share a target", async () => {
    const rows = bundleRows(await renderPageTree());
    expect(rows.map((row) => row.key)).toEqual([FIXTURE.id, DISPOSABLE.id]);

    const targets = rows.map((row) => {
      const buttons = collectElements(row).filter((el) => el.type === DeleteBundleButton);
      expect(buttons).toHaveLength(1);
      return buttons[0].props as { bundleId: string; title: string; status: string };
    });
    expect(targets).toEqual([
      { bundleId: FIXTURE.id, title: FIXTURE.title, status: FIXTURE.status },
      { bundleId: DISPOSABLE.id, title: DISPOSABLE.title, status: DISPOSABLE.status },
    ]);
    // The row's visible title is the one the confirmation will show.
    rows.forEach((row, i) => expect(textOf(row)).toContain(targets[i].title));
  });

  it("confirming on the disposable row deletes only it; confirming on Fixture Bundle names and deletes only Fixture Bundle", async () => {
    const rows = bundleRows(await renderPageTree());
    const [fixtureButton, disposableButton] = rows.map(
      (row) => collectElements(row).find((el) => el.type === DeleteBundleButton)!,
    );

    stubConfirm(true);
    mount(disposableButton.props as Target).click();
    await Promise.resolve();
    expect(confirmSpy.mock.calls[0][0]).toContain(`"${DISPOSABLE.title}"`);
    expect(confirmSpy.mock.calls[0][0]).not.toContain(FIXTURE.title);
    expect(mockDeleteBundle.mock.calls).toEqual([[DISPOSABLE.id]]);

    mockDeleteBundle.mockClear();
    stubConfirm(false);
    mount(fixtureButton.props as Target).click();
    await Promise.resolve();
    expect(confirmSpy.mock.calls[0][0]).toContain('"Fixture Bundle"');
    expect(confirmSpy.mock.calls[0][0]).not.toContain(DISPOSABLE.title);
    expect(mockDeleteBundle).not.toHaveBeenCalled();
  });

  it("the same holds with the rows in the other order", async () => {
    pageBundles = [DISPOSABLE, FIXTURE];
    const rows = bundleRows(await renderPageTree());
    const targets = rows.map(
      (row) => (collectElements(row).find((el) => el.type === DeleteBundleButton)!.props as { bundleId: string; title: string }),
    );
    expect(targets.map((t) => [t.bundleId, t.title])).toEqual([
      [DISPOSABLE.id, DISPOSABLE.title],
      [FIXTURE.id, FIXTURE.title],
    ]);
  });

  it("Edit, Publish and Unpublish still target the row they sit on", async () => {
    const SECOND_DRAFT = { id: "b0000000-0000-4000-8000-0000000000d2", title: "Second draft", status: "draft", price_all: 0 };
    const SECOND_PUBLISHED = { id: "b0000000-0000-4000-8000-0000000000f2", title: "Second published", status: "published", price_all: 0 };
    pageBundles = [FIXTURE, DISPOSABLE, SECOND_DRAFT, SECOND_PUBLISHED];
    const rows = bundleRows(await renderPageTree());
    expect(rows.map((row) => row.key)).toEqual(pageBundles.map((b) => (b as { id: string }).id));

    for (const [i, row] of rows.entries()) {
      const bundle = pageBundles[i] as { id: string; status: string };
      const hrefs = collectElements(row)
        .filter((el) => el.type === Link)
        .map((el) => (el.props as { href: string }).href);
      expect(hrefs).toEqual([`/dashboard/bundles/${bundle.id}/edit`]);

      const forms = collectElements(row).filter((el) => el.type === "form") as ReactElement<{
        action: () => Promise<void>;
        children: ReactNode;
      }>[];
      const expectedLabel = bundle.status === "draft" ? "Publish" : "Unpublish";
      expect(forms.map((f) => textOf(f.props.children).trim())).toEqual([expectedLabel]);

      mockPublishBundle.mockClear();
      mockUnpublishBundle.mockClear();
      await forms[0].props.action();
      const [called, notCalled] =
        bundle.status === "draft" ? [mockPublishBundle, mockUnpublishBundle] : [mockUnpublishBundle, mockPublishBundle];
      expect(called.mock.calls).toEqual([[bundle.id]]);
      expect(notCalled).not.toHaveBeenCalled();
    }

    expect(mockDeleteBundle).not.toHaveBeenCalled();
  });

  it("the rendered page shows one named Delete per row and no delete form", async () => {
    const html = renderToStaticMarkup(await renderPageTree());
    expect(html).toContain('aria-label="Delete bundle “Fixture Bundle”"');
    expect(html).toContain(`aria-label="Delete bundle “${DISPOSABLE.title}”"`);
    expect(html.match(/aria-label="Delete bundle /g)).toHaveLength(2);
    expect(html.match(/<form/g)).toHaveLength(3); // create, Unpublish, Publish
  });

  it("the page shows the success banner the confirmed delete redirects to", async () => {
    const tree = (await BundlesPage({ searchParams: Promise.resolve({ success: "Bundle deleted" }) })) as ReactElement;
    expect(renderToStaticMarkup(tree)).toContain("Bundle deleted");
  });
});
