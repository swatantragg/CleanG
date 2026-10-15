// Human-readable role labels + the assignable-role list, shared by the admin
// Users page, the profile menu and the activity view — so a role always renders
// as its label (never the raw enum value) in every place.
//
// The API already masks super admins as "admin" for everyone but a super admin,
// so "super_admin" only ever reaches a super admin's screen.

export const ROLE_LABELS = {
  super_admin: "Super admin",
  admin: "Admin",
  // Legacy role: no longer assignable, but existing accounts may still hold it.
  superuser: "Super user",
  user: "User",
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || "";
}

// Roles an admin may assign, in display order (least to most privileged).
export const ASSIGNABLE_ROLES = ["user", "admin"];

export function isAdmin(user) {
  return user?.role === "admin" || user?.role === "super_admin";
}

export function isSuperAdmin(user) {
  return user?.role === "super_admin";
}

// Admins (and legacy super users) see, edit and delete every branch.
export function canManageAllBranches(user) {
  return isAdmin(user) || user?.role === "superuser";
}
