import { useCallback, useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { APP_VERSION, RELEASE_NOTES } from "../version.js";
import { isAdmin, isSuperAdmin } from "../utils/roles.js";

// Remembered per user, so a shared browser still shows it once to each person.
function seenKey(user) {
  return `mrm_seen_version:${user?.id ?? "anon"}`;
}

function alreadySeen(user) {
  try {
    return localStorage.getItem(seenKey(user)) === APP_VERSION;
  } catch {
    return false;
  }
}

function markSeen(user) {
  try {
    localStorage.setItem(seenKey(user), APP_VERSION);
  } catch {
    // Storage blocked: it just shows again next visit.
  }
}

const TAG_ORDER = ["New", "Improved", "Fixed"];

/**
 * Summary card for the current release: one line per change, grouped
 * New / Improved / Fixed. Small and non-blocking (bottom-right, no overlay).
 */
function WhatsNew({ user, onClose }) {
  const notes = RELEASE_NOTES.filter(
    (n) =>
      (!n.superAdmin || isSuperAdmin(user)) && (!n.admin || isAdmin(user))
  ).sort((a, b) => TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag));

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="whats-new" role="dialog" aria-labelledby="whats-new-title">
      <div className="whats-new-head">
        <span className="whats-new-spark">
          <Icon name="sparkles" size={16} />
        </span>
        <h3 id="whats-new-title">What's new in V{APP_VERSION}</h3>
        <button
          type="button"
          className="whats-new-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n.text}>
            {n.tag && (
              <span className={`whats-new-tag tag-${n.tag.toLowerCase()}`}>{n.tag}</span>
            )}
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn primary sm" onClick={onClose}>
        Got it
      </button>
    </aside>
  );
}

/**
 * Page footer with the version badge. A signed-in user gets the release summary
 * automatically ONCE per version (it is marked seen the moment it appears, so a
 * reload or a skipped "Got it" never brings it back); afterwards it only opens
 * from a click on the version badge.
 */
export default function AppFooter({ user }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ready = Boolean(user) && !user.must_change_password;

  // Keyed on the user id: a different account in the same browser gets its own once.
  useEffect(() => {
    if (!ready || alreadySeen(user)) return;
    markSeen(user);
    setOpen(true);
  }, [ready, user?.id]);

  // Signing out closes it with the session.
  useEffect(() => {
    if (!user) setOpen(false);
  }, [user]);

  return (
    <>
      <footer className="app-footer">
        <button
          type="button"
          className="version-badge"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          title="What's new in this version"
        >
          V{APP_VERSION}
        </button>
      </footer>
      {open && <WhatsNew user={user} onClose={close} />}
    </>
  );
}
