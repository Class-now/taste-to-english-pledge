import { describe, expect, it } from "vitest";
import { parsePlanInput } from "../src/validate";

const valid = {
  favorites: [{ title: "  Spirited Away " }, { title: "Persona 5", type: "videogame" }],
  level: "B1",
  minutesPerDay: 20,
  formats: ["read", "listen"],
};

function expectError(body: unknown, match: RegExp) {
  const r = parsePlanInput(body);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(match);
}

describe("parsePlanInput", () => {
  it("accepts a valid body and trims titles", () => {
    const r = parsePlanInput(valid);
    expect(r).toEqual({
      ok: true,
      value: {
        favorites: [{ title: "Spirited Away" }, { title: "Persona 5", type: "videogame" }],
        level: "B1",
        minutesPerDay: 20,
        formats: ["read", "listen"],
      },
    });
  });

  it("keeps a non-empty refine and dedupes formats", () => {
    const r = parsePlanInput({ ...valid, formats: ["watch", "watch"], refine: " less fantasy " });
    expect(r.ok && r.value.formats).toEqual(["watch"]);
    expect(r.ok && r.value.refine).toBe("less fantasy");
  });

  it("treats empty type as auto", () => {
    const r = parsePlanInput({ ...valid, favorites: [{ title: "X", type: "" }] });
    expect(r.ok && r.value.favorites).toEqual([{ title: "X" }]);
  });

  it("rejects non-object bodies", () => {
    expectError(null, /JSON object/);
    expectError([], /JSON object/);
    expectError("hi", /JSON object/);
  });

  it("rejects bad favourites", () => {
    expectError({ ...valid, favorites: [] }, /between 1 and 5/);
    expectError({ ...valid, favorites: Array(6).fill({ title: "a" }) }, /between 1 and 5/);
    expectError({ ...valid, favorites: [{ title: "   " }] }, /title must be/);
    expectError({ ...valid, favorites: [{ title: "x".repeat(81) }] }, /title must be/);
    expectError({ ...valid, favorites: [{ title: 3 }] }, /needs a title/);
    expectError({ ...valid, favorites: ["Spirited Away"] }, /must be an object/);
    expectError({ ...valid, favorites: [{ title: "X", type: "anime" }] }, /type must be one of/);
  });

  it("rejects bad level, minutes, formats, refine", () => {
    expectError({ ...valid, level: "C2" }, /Level/);
    expectError({ ...valid, minutesPerDay: 15 }, /Minutes/);
    expectError({ ...valid, minutesPerDay: "20" }, /Minutes/);
    expectError({ ...valid, formats: [] }, /at least one format/);
    expectError({ ...valid, formats: ["read", "sing"] }, /Formats/);
    expectError({ ...valid, refine: "x".repeat(201) }, /at most 200/);
    expectError({ ...valid, refine: 5 }, /Refine/);
  });
});
