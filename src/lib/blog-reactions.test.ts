import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  BLOG_REACTIONS,
  emptyBlogReactionCounts,
  groupBlogReactionCounts,
  isBlogReaction,
  publicReactionCount,
} from "./blog-reactions";

describe("BLOG_REACTIONS (br1 q1)", () => {
  it("three reactions, in Renato's order, with their Albanian labels", () => {
    expect(BLOG_REACTIONS.map((r) => `${r.emoji} ${r.label}`)).toEqual([
      "👍 Më pëlqen",
      "💡 E dobishme",
      "✨ Më frymëzoi",
    ]);
  });

  it("the keys are exactly the ones the database CHECK and toggle function accept", () => {
    const migration = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261123190000_blog_post_reactions.sql"),
      "utf8",
    );
    const lists = migration.match(/in \('like', 'helpful', 'inspired'\)/g) ?? [];
    expect(lists).toHaveLength(2);
    expect(BLOG_REACTIONS.map((r) => r.key)).toEqual(["like", "helpful", "inspired"]);
  });
});

describe("isBlogReaction", () => {
  it("accepts the three keys only", () => {
    expect(isBlogReaction("like")).toBe(true);
    expect(isBlogReaction("helpful")).toBe(true);
    expect(isBlogReaction("inspired")).toBe(true);
    expect(isBlogReaction("love")).toBe(false);
    expect(isBlogReaction("")).toBe(false);
    expect(isBlogReaction(null)).toBe(false);
    expect(isBlogReaction("LIKE")).toBe(false);
  });
});

describe("groupBlogReactionCounts", () => {
  it("groups by article and fills missing reactions with 0", () => {
    const byPost = groupBlogReactionCounts([
      { post_id: "a", reaction: "like", total: 3 },
      { post_id: "a", reaction: "inspired", total: "1" },
      { post_id: "b", reaction: "helpful", total: 5 },
    ]);
    expect(byPost.get("a")).toEqual({ like: 3, helpful: 0, inspired: 1 });
    expect(byPost.get("b")).toEqual({ like: 0, helpful: 5, inspired: 0 });
    expect(byPost.get("c")).toBeUndefined();
  });

  it("drops unknown reactions and broken totals", () => {
    const byPost = groupBlogReactionCounts([
      { post_id: "a", reaction: "love", total: 3 },
      { post_id: "a", reaction: "like", total: -1 },
      { post_id: "a", reaction: "helpful", total: "x" },
      { post_id: "a", reaction: "inspired", total: 1.5 },
    ]);
    expect(byPost.get("a")).toBeUndefined();
  });

  it("no rows (or a failed read) gives an empty map", () => {
    expect(groupBlogReactionCounts(null).size).toBe(0);
    expect(groupBlogReactionCounts(undefined).size).toBe(0);
    expect(groupBlogReactionCounts([]).size).toBe(0);
  });

  it("each article gets its own counts object", () => {
    const empty = emptyBlogReactionCounts();
    empty.like = 9;
    expect(emptyBlogReactionCounts()).toEqual({ like: 0, helpful: 0, inspired: 0 });
  });
});

describe("publicReactionCount (br1 q4)", () => {
  it("hides zero, shows anything above", () => {
    expect(publicReactionCount(0)).toBeNull();
    expect(publicReactionCount(1)).toBe("1");
    expect(publicReactionCount(120)).toBe("120");
  });
});
