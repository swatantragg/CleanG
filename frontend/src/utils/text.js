// Tiny presentation-only helpers for naming user-created master columns.
// (All business logic lives on the backend; these just label a new column.)

export const titleCase = (s) =>
  (s || "")
    .toString()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

export const slug = (s) => (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
