import { describe, expect, it } from "vitest";
import { selectPicks, type LevelEstimate } from "../src/select";
import type { Cefr, EntityType, QlooEntity } from "../src/types";

const ent = (id: string, type: EntityType, affinity: number): QlooEntity => ({ id, name: id, type, affinity, tags: [] });
const lvl = (id: string, cefr: Cefr): LevelEstimate => ({ id, cefr, reason: `r-${id}` });

describe("selectPicks", () => {
  it("keeps only levels within one step of the learner and labels fit", () => {
    const c = [ent("a", "book", 0.9), ent("b", "book", 0.8), ent("c", "book", 0.7), ent("d", "book", 0.6), ent("e", "book", 0.5)];
    const l = [lvl("a", "A2"), lvl("b", "B1"), lvl("c", "B2"), lvl("d", "C1"), lvl("e", "C2")];
    const picks = selectPicks(c, l, "B1", ["read"]);
    expect(picks.map((p) => [p.id, p.fit])).toEqual([
      ["a", "easier"],
      ["b", "match"],
      ["c", "stretch"],
    ]);
    expect(picks[0]).toMatchObject({ cefr: "A2", levelReason: "r-a", format: "read", because: "" });
  });

  it("caps at 9, prefers match then stretch then easier", () => {
    const c = Array.from({ length: 12 }, (_, i) => ent(`p${i}`, "podcast", 1 - i / 100));
    const l = c.map((e, i) => lvl(e.id, i < 4 ? "A2" : i < 8 ? "B1" : "B2"));
    const picks = selectPicks(c, l, "B1", ["listen"]);
    expect(picks).toHaveLength(9);
    expect(picks.filter((p) => p.fit === "match")).toHaveLength(4);
    expect(picks.filter((p) => p.fit === "stretch")).toHaveLength(4);
    expect(picks.filter((p) => p.fit === "easier")).toHaveLength(1);
    expect(picks.find((p) => p.fit === "easier")?.id).toBe("p0"); // highest-affinity easier one
  });

  it("guarantees at least 2 per selected format when available", () => {
    const c = [
      ...Array.from({ length: 10 }, (_, i) => ent(`b${i}`, "book", 0.99 - i / 100)),
      ent("t1", "tv_show", 0.2),
      ent("m1", "movie", 0.1),
      ent("p1", "podcast", 0.3),
    ];
    const l = c.map((e) => lvl(e.id, e.type === "book" ? "B1" : "B2"));
    const picks = selectPicks(c, l, "B1", ["read", "listen", "watch"]);
    expect(picks).toHaveLength(9);
    expect(picks.filter((p) => p.format === "watch").map((p) => p.id).sort()).toEqual(["m1", "t1"]);
    expect(picks.filter((p) => p.format === "listen").map((p) => p.id)).toEqual(["p1"]);
  });

  it("orders easiest first, then by affinity, and ignores unselected formats and unrated candidates", () => {
    const c = [ent("x", "book", 0.5), ent("y", "book", 0.9), ent("z", "book", 0.7), ent("g", "videogame", 1), ent("u", "book", 1)];
    const l = [lvl("x", "B2"), lvl("y", "B2"), lvl("z", "B1"), lvl("g", "B1")];
    const picks = selectPicks(c, l, "B1", ["read", "watch"]);
    expect(picks.map((p) => p.id)).toEqual(["z", "y", "x"]);
  });
});
