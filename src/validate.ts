import {
  ENTITY_TYPES,
  FORMATS,
  LEARNER_LEVELS,
  MINUTES_PER_DAY,
  type EntityType,
  type Favorite,
  type Format,
  type LearnerLevel,
  type MinutesPerDay,
  type PlanInput,
} from "./types";

export type ParseResult = { ok: true; value: PlanInput } | { ok: false; error: string };

const MAX_FAVORITES = 5;
const MAX_TITLE = 80;
const MAX_REFINE = 200;

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parsePlanInput(body: unknown): ParseResult {
  if (!isRecord(body)) return fail("Request body must be a JSON object.");

  const rawFavs = body.favorites;
  if (!Array.isArray(rawFavs) || rawFavs.length < 1 || rawFavs.length > MAX_FAVORITES) {
    return fail(`Enter between 1 and ${MAX_FAVORITES} favourites.`);
  }
  const favorites: Favorite[] = [];
  for (const [i, raw] of rawFavs.entries()) {
    if (!isRecord(raw)) return fail(`Favourite #${i + 1} must be an object with a title.`);
    if (typeof raw.title !== "string") return fail(`Favourite #${i + 1} needs a title.`);
    const title = raw.title.trim();
    if (title.length < 1 || title.length > MAX_TITLE) {
      return fail(`Favourite #${i + 1} title must be 1–${MAX_TITLE} characters.`);
    }
    const fav: Favorite = { title };
    if (raw.type !== undefined && raw.type !== null && raw.type !== "") {
      if (typeof raw.type !== "string" || !(ENTITY_TYPES as readonly string[]).includes(raw.type)) {
        return fail(`Favourite #${i + 1} type must be one of: ${ENTITY_TYPES.join(", ")}.`);
      }
      fav.type = raw.type as EntityType;
    }
    favorites.push(fav);
  }

  if (typeof body.level !== "string" || !(LEARNER_LEVELS as readonly string[]).includes(body.level)) {
    return fail(`Level must be one of: ${LEARNER_LEVELS.join(", ")}.`);
  }
  const level = body.level as LearnerLevel;

  if (typeof body.minutesPerDay !== "number" || !(MINUTES_PER_DAY as readonly number[]).includes(body.minutesPerDay)) {
    return fail(`Minutes per day must be one of: ${MINUTES_PER_DAY.join(", ")}.`);
  }
  const minutesPerDay = body.minutesPerDay as MinutesPerDay;

  if (!Array.isArray(body.formats) || body.formats.length === 0) {
    return fail("Choose at least one format: read, listen or watch.");
  }
  const formats: Format[] = [];
  for (const f of body.formats) {
    if (typeof f !== "string" || !(FORMATS as readonly string[]).includes(f)) {
      return fail(`Formats must be chosen from: ${FORMATS.join(", ")}.`);
    }
    if (!formats.includes(f as Format)) formats.push(f as Format);
  }

  const value: PlanInput = { favorites, level, minutesPerDay, formats };

  if (body.refine !== undefined && body.refine !== null) {
    if (typeof body.refine !== "string") return fail("Refine must be text.");
    const refine = body.refine.trim();
    if (refine.length > MAX_REFINE) return fail(`Refine text must be at most ${MAX_REFINE} characters.`);
    if (refine) value.refine = refine;
  }

  if (body.demo !== undefined && body.demo !== null) {
    if (typeof body.demo !== "boolean") return fail("Demo must be true or false.");
    if (body.demo) value.demo = true;
  }

  return { ok: true, value };
}
