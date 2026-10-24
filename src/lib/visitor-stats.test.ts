import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COUNTED_PATHS,
  isCountedPath,
  isVisitorStatsEnabled,
  prepareVisitEvent,
} from "./visitor-stats";

// VISITOR STATS (pipeline item 6, Renato 10-24: 1. a, 2. a).
const appDir = path.join(__dirname, "..", "app");
const publicDir = path.join(appDir, "(public)");

// Every (public) top-level folder must be either counted or left out
// on purpose, so a new page can't slip in without a decision.
const NOT_COUNTED_FOLDERS = [
  "account",
  "auth",
  "dashboard",
  "following",
  "forgot-password",
  "library",
  "login",
  "reset-password",
  "signup",
  "wishlist",
];

const ORIGIN = "https://librum.al";
const view = (url: string) => ({ type: "pageview" as const, url });

describe("VISITOR STATS: where the script loads", () => {
  it("is on for Vercel Production only", () => {
    expect(isVisitorStatsEnabled({ VERCEL_ENV: "production" })).toBe(true);
    for (const value of ["preview", "development", "Production", "", undefined]) {
      expect(isVisitorStatsEnabled({ VERCEL_ENV: value })).toBe(false);
    }
    expect(isVisitorStatsEnabled({})).toBe(false);
  });

  it("renders from the (public) layout behind the Production check, never from admin or the root layout", () => {
    const publicLayout = readFileSync(path.join(publicDir, "layout.tsx"), "utf8");
    expect(publicLayout).toContain("{isVisitorStatsEnabled(process.env) && <VisitorStats />}");
    expect(publicLayout.match(/<VisitorStats\b/g)).toHaveLength(1);
    for (const file of ["layout.tsx", "admin/layout.tsx"]) {
      const source = readFileSync(path.join(appDir, file), "utf8");
      expect(source).not.toMatch(/VisitorStats|@vercel\/analytics/);
    }
  });

  it("passes the filter to every event", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "components", "visitor-stats.tsx"),
      "utf8",
    );
    expect(source).toContain("<Analytics beforeSend={prepareVisitEvent} />");
  });
});

describe("VISITOR STATS: which pages count", () => {
  it("counts the home page and public store pages, including their sub-pages", () => {
    for (const p of [
      "/",
      "/bookstore",
      "/books/abc",
      "/books/abc/report",
      "/authors/abc",
      "/series/abc",
      "/bundles/abc",
      "/blog",
      "/blog/a-post",
      "/help",
      "/help/reading",
      "/about",
      "/contact",
      "/how-it-works",
      "/pricing",
      "/privacy",
      "/refunds",
      "/terms",
    ]) {
      expect(isCountedPath(p), p).toBe(true);
    }
  });

  it("never counts admin, signed-in areas or sign-in pages", () => {
    for (const p of [
      "/admin",
      "/admin/login",
      "/dashboard",
      "/dashboard/books/abc/edit",
      "/account",
      "/library",
      "/wishlist",
      "/following",
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
      "/auth/callback",
      "/payments/return",
      "/api/anything",
    ]) {
      expect(isCountedPath(p), p).toBe(false);
    }
  });

  it("matches whole path segments only", () => {
    expect(isCountedPath("/bookstore-old")).toBe(false);
    expect(isCountedPath("/helpdesk")).toBe(false);
    expect(isCountedPath("/terms.txt")).toBe(false);
    expect(isCountedPath("")).toBe(false);
  });

  it("has a decision for every (public) folder", () => {
    const folders = readdirSync(publicDir)
      .filter((name) => statSync(path.join(publicDir, name)).isDirectory())
      .sort();
    const decided = [
      ...COUNTED_PATHS.map((p) => p.slice(1)),
      ...NOT_COUNTED_FOLDERS,
    ].sort();
    expect(folders).toEqual(decided);
  });
});

describe("VISITOR STATS: what is sent", () => {
  it("cuts everything after ? or #", () => {
    expect(prepareVisitEvent(view(`${ORIGIN}/bookstore?q=my+search&genre=x`))).toEqual(
      view(`${ORIGIN}/bookstore`),
    );
    expect(prepareVisitEvent(view(`${ORIGIN}/books/abc#reviews`))).toEqual(
      view(`${ORIGIN}/books/abc`),
    );
    expect(prepareVisitEvent(view(`${ORIGIN}/?code=secret#access_token=x`))).toEqual(
      view(`${ORIGIN}/`),
    );
  });

  it("drops events from pages that don't count, with or without a query", () => {
    expect(prepareVisitEvent(view(`${ORIGIN}/reset-password?code=secret`))).toBeNull();
    expect(prepareVisitEvent(view(`${ORIGIN}/auth/callback?code=secret`))).toBeNull();
    expect(prepareVisitEvent(view(`${ORIGIN}/admin`))).toBeNull();
    expect(prepareVisitEvent({ type: "event" as const, url: `${ORIGIN}/dashboard` })).toBeNull();
  });

  it("drops an address it can't read instead of sending it", () => {
    expect(prepareVisitEvent(view("not a url"))).toBeNull();
    expect(prepareVisitEvent(view(""))).toBeNull();
  });

  it("keeps the event type and doesn't change the original event", () => {
    const original = { type: "event" as const, url: `${ORIGIN}/help?x=1` };
    expect(prepareVisitEvent(original)).toEqual({ type: "event", url: `${ORIGIN}/help` });
    expect(original.url).toBe(`${ORIGIN}/help?x=1`);
  });
});
