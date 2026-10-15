import { useState } from "react";
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

/**
 * One-time "What's new" popup for the current release. Small and non-blocking
 * (bottom-right card, no overlay); dismissing it marks this version as seen.
 */
export default function WhatsNew({ user }) {
  const [open, setOpen] = useState(() => !alreadySeen(user));
  if (!open) return null;

  const notes = RELEASE_NOTES.filter(
    (n) =>
      (!n.superAdmin || isSuperAdmin(user)) && (!n.admin || isAdmin(user))
  );

  function dismiss() {
    try {
      localStorage.setItem(seenKey(user), APP_VERSION);
    } catch {
      // Storage blocked: it just shows again next visit.
    }
    setOpen(false);
  }

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
          onClick={dismiss}
          aria-label="Close"
          title="Close"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n.text}>{n.text}</li>
        ))}
      </ul>
      <button type="button" className="btn primary sm" onClick={dismiss}>
        Got it
      </button>
    </aside>
  );
}
