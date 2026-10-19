// App version shown in the footer, and the "What's new" summary for it.
// On every release: bump APP_VERSION and replace RELEASE_NOTES — each signed-in
// user then sees the popup once (per browser) for the new version; after that it
// opens only when they click the version badge in the footer.

export const APP_VERSION = "2.9.0";

// One short point per change, tagged New / Improved / Fixed for the summary.
// `superAdmin: true` notes are shown only to super admins; `admin: true` notes
// only to admins (super admins included).
export const RELEASE_NOTES = [
  { tag: "New", text: "PRS standardization accepts IPRS work listings." },
  { tag: "New", text: "Click the version badge to reopen these notes." },
  { tag: "Improved", text: "Footer stays in the bottom-right corner." },
  { tag: "Fixed", text: "False “headers but no data rows” error on some Excel files." },
];
