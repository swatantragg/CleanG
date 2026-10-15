// App version shown in the footer, and the one-time "What's new" popup for it.
// On every release: bump APP_VERSION and replace RELEASE_NOTES — each signed-in
// user then sees the popup once (per browser) for the new version.

export const APP_VERSION = "2.8.0";

// One short point per change. `superAdmin: true` notes are shown only to super
// admins; `admin: true` notes only to admins (super admins included).
export const RELEASE_NOTES = [
  { text: "Cleaner header: the logo no longer carries extra side spacing." },
  { text: "Profile menu: click your name to see your role, switch theme or sign out." },
  { text: "Footer now shows just the app version." },
  { text: "Roles simplified to Admin and User.", admin: true },
  {
    text: "Super admin: set a new password for any user or admin from Users.",
    superAdmin: true,
  },
  {
    text: "New Mail tab: start or stop the daily report and choose who receives it.",
    superAdmin: true,
  },
];
