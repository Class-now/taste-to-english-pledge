import { describe, expect, it } from "vitest";
import { explainPick } from "../src/explain";
import type { QlooEntity } from "../src/types";

const tag = (key: string, name: string) => ({ id: `urn:tag:${key}`, name });
const seedA: QlooEntity = { id: "seed-a", name: "Spirited Away", type: "movie", tags: [tag("fantasy", "Fantasy"), tag("coa", "Coming Of Age"), tag("japan", "Japan")] };
const seedB: QlooEntity = { id: "seed-b", name: "Persona 5", type: "videogame", tags: [tag("mystery", "Mystery"), tag("friendship", "Friendship")] };

describe("explainPick", () => {
  it("uses the seed named in explainability", () => {
    const pick: QlooEntity = {
      id: "p",
      name: "P",
      type: "book",
      tags: [tag("fantasy", "Fantasy")],
      explainability: { entities: [{ entity_id: "seed-b", score: 0.6 }, { entity_id: "seed-a", score: 0.3 }] },
    };
    expect(explainPick(pick, [seedA, seedB])).toBe("Because you like Persona 5");
  });

  it("falls back to the seed with the most shared tags, naming up to two", () => {
    const pick: QlooEntity = {
      id: "p",
      name: "P",
      type: "book",
      tags: [tag("fantasy", "Fantasy"), tag("coa", "Coming Of Age"), tag("japan", "Japan"), tag("mystery", "Mystery")],
      explainability: { entities: [{ entity_id: "someone-else" }] },
    };
    expect(explainPick(pick, [seedA, seedB])).toBe("Shares fantasy and coming of age with Spirited Away");
  });

  it("matches tags by name when ids differ and handles a single shared tag", () => {
    const pick: QlooEntity = { id: "p", name: "P", type: "podcast", tags: [{ id: "urn:tag:genre:mystery", name: "mystery" }] };
    expect(explainPick(pick, [seedA, seedB])).toBe("Shares mystery with Persona 5");
  });

  it("falls back to the affinity score, then a generic line", () => {
    const pick: QlooEntity = { id: "p", name: "P", type: "podcast", tags: [], affinity: 0.874 };
    expect(explainPick(pick, [seedA])).toBe("Close to your overall taste (87% match)");
    expect(explainPick({ ...pick, affinity: undefined }, [seedA])).toBe("Recommended by Qloo for your taste");
  });
  it("reads seed ids used as explainability keys and picks the top score", () => {
    const pick: QlooEntity = { id: "p", name: "P", type: "book", tags: [], explainability: { "seed-a": 0.2, "seed-b": 0.7 } };
    expect(explainPick(pick, [seedA, seedB])).toBe("Because you like Persona 5");
  });

  it("falls back to tags shared with the taste profile when seeds have no tags", () => {
    const pick: QlooEntity = { id: "p", name: "P", type: "book", tags: [tag("mystery", "Mystery")], affinity: 0.5 };
    const bare = [{ ...seedA, tags: [] }];
    expect(explainPick(pick, bare, [tag("mystery", "Mystery")])).toBe("Matches your taste for mystery");
  });
});
