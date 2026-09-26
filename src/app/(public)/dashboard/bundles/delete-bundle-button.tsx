"use client";

import { Component, startTransition } from "react";
import { deleteBundle } from "./actions";

// BUNDLE-DELETE-SAFETY-1: deleting a bundle is irreversible, and every
// row on /dashboard/bundles used to delete on one click with nothing
// saying which bundle it was. The browser's own confirmation dialog now
// names the exact bundle, and the action is called only after the author
// accepts it. Canceling calls nothing. Without JavaScript the button
// does nothing at all rather than deleting unconfirmed.
//
// Each mounted button is single-flight: one confirmed deletion is one
// deleteBundle call. The lock is taken synchronously the moment the
// author accepts, before the action is scheduled, and held until the
// action settles -- resolved, rejected, or rejected by Next's redirect
// on the way to the result page. While it is held, clicks are ignored
// before any dialog opens and the button is disabled and marked busy.
// The lock belongs to this row's button only.
//
// A class component so the lock is a plain synchronous field and the
// behavior can be exercised in the existing Node test stack without a
// DOM.

type BundleDeleteTarget = {
  bundleId: string;
  title: string;
  status: string;
};

type DeleteBundleButtonState = { pending: boolean };

export type BundleDeleteDependencies = {
  confirm: (message: string) => boolean;
  action: (bundleId: string) => Promise<void>;
};

const browserDependencies: BundleDeleteDependencies = {
  confirm: (message) => window.confirm(message),
  action: deleteBundle,
};

export function bundleDeleteConfirmationMessage({ title, status }: Omit<BundleDeleteTarget, "bundleId">): string {
  const state = status === "published" ? "published " : status === "draft" ? "draft " : "";
  return (
    `Delete the ${state}bundle "${title}"?\n\n` +
    `This can't be undone. The books in it are not deleted.`
  );
}

export class DeleteBundleButton extends Component<BundleDeleteTarget, DeleteBundleButtonState> {
  state: DeleteBundleButtonState = { pending: false };

  // The single-flight lock. A field, not state: React state updates are
  // not visible synchronously, and a second click must see the lock at once.
  private inFlight = false;

  // Replaced only by tests.
  dependencies: BundleDeleteDependencies = browserDependencies;

  isLocked(): boolean {
    return this.inFlight;
  }

  // Returns whether this click called the action.
  requestDeletion = (): boolean => {
    if (this.inFlight) {
      return false;
    }
    const { bundleId, title, status } = this.props;
    const { confirm, action } = this.dependencies;
    if (confirm(bundleDeleteConfirmationMessage({ title, status })) !== true) {
      return false;
    }

    this.inFlight = true;
    this.setState({ pending: true });

    startTransition(async () => {
      try {
        await action(bundleId);
      } finally {
        this.inFlight = false;
        this.setState({ pending: false });
      }
    });
    return true;
  };

  render() {
    const { title } = this.props;
    const { pending } = this.state;
    return (
      <button
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-label={pending ? `Deleting bundle “${title}”…` : `Delete bundle “${title}”`}
        className="focus-ring rounded-lg border border-border px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={this.requestDeletion}
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
    );
  }
}
