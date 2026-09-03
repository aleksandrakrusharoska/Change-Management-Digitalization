import peopleData from "./people.json" with { type: "json" };

interface PersonEntry {
  email: string;
  aliases?: string[];
}

// Build a fast lookup: normalized name/alias -> email
const emailIndex = new Map<string, string>();

function norm(s: string): string {
  return s.replace(/^@/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

for (const [name, raw] of Object.entries(peopleData)) {
  if (name.startsWith("_")) continue; // skip _comment
  const p = raw as PersonEntry;
  emailIndex.set(norm(name), p.email);
  for (const alias of p.aliases ?? []) emailIndex.set(norm(alias), p.email);
}

/** Resolve a name/handle as written in the notes to that person's email (or null). */
export function resolveEmail(name: string | null | undefined): string | null {
  if (!name) return null;
  return emailIndex.get(norm(name)) ?? null;
}