// Human-readable role labels + the assignable-role list, shared by the admin
// Users page, the top-bar role pill and the activity view — so "superuser" always
// renders as "Super user" (never the raw enum value) in every place.

export const ROLE_LABELS = {
  admin: "Admin",
  superuser: "Super user",
  user: "User",
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || "";
}

// Roles an admin may assign, in display order (least to most privileged).
export const ASSIGNABLE_ROLES = ["user", "superuser", "admin"];
