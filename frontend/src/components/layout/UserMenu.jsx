// Top-right user profile: name + avatar, dropdown with details + logout,
// plus a quick light/dark theme toggle.

import { useState, useRef, useEffect } from "react";
import { useTheme } from "../../context/ThemeContext";

const SunIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const MoonIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
const LogoutIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
);

export default function UserMenu({ user, logout }) {
  const [open, setOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const displayName = user?.name || user?.email || "User";
  const initial = (displayName.trim()[0] || "U").toUpperCase();

  return (
    <div className="usermenu" ref={ref}>
      <button className="themebtn" onClick={toggle} title={theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle theme">
        {theme === "dark" ? SunIcon : MoonIcon}
      </button>

      <button className="profilebtn" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}>
        <span className="avatar">{initial}</span>
        <span className="pname">{displayName}</span>
        <span className="chev">▼</span>
      </button>

      {open && (
        <div className="usermenu-pop">
          <div className="um-head">
            <div className="avatar lg">{initial}</div>
            <div style={{ minWidth: 0 }}>
              <div className="um-name">{user?.name || "—"}</div>
              <div className="um-email">{user?.email}</div>
              {user?.role && <span className="pill slate" style={{ marginTop: 6 }}>{user.role}</span>}
            </div>
          </div>
          <button className="um-item danger" onClick={logout}>
            {LogoutIcon}
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
