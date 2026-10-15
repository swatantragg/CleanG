import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import Icon from "./Icon.jsx";
import WhatsNew from "./WhatsNew.jsx";
import { isAdmin, isSuperAdmin, roleLabel } from "../utils/roles.js";

const THEME_KEY = "mrm_theme";

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function initials(name = "") {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function firstName(user) {
  return (user?.full_name || "").trim().split(/\s+/)[0] || user?.email || "";
}

/** Avatar + first name; opens a small menu with role, theme and sign out. */
function ProfileMenu({ user, theme, onToggleTheme, onLogout }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-box" ref={boxRef}>
      <button
        type="button"
        className="profile-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="avatar">{initials(user?.full_name)}</span>
        <span className="user-name">{firstName(user)}</span>
        <Icon name="chevronDown" size={14} className="profile-caret" />
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-menu-head">
            <strong>{user?.full_name}</strong>
            <span className="muted small profile-email" title={user?.email}>
              {user?.email}
            </span>
          </div>
          <div className="profile-menu-row">
            <span>Role</span>
            <span className="role-pill">{roleLabel(user?.role)}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="profile-menu-row profile-menu-item"
            onClick={onToggleTheme}
          >
            <span>Theme</span>
            <span className="profile-theme">
              <Icon name={theme === "dark" ? "moon" : "sun"} size={15} />
              {theme === "dark" ? "Dark" : "Light"}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="profile-menu-item profile-signout"
            onClick={onLogout}
          >
            <Icon name="logout" size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The branch workspace (upload → map → clean → review) is data-dense: give it
  // the full screen width so the review grid uses the side space.
  const wide = /^\/branches\/\d+/.test(pathname);

  const [theme, setTheme] = useState(
    () => localStorage.getItem(THEME_KEY) || "light"
  );
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="MRM Cleanser" className="brand-logo" />
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            <Icon name="branch" size={16} /> Branches
          </NavLink>
          <NavLink to="/standardize">
            <Icon name="sparkles" size={16} /> Standardize
          </NavLink>
          <NavLink to="/export">
            <Icon name="download" size={16} /> Export
          </NavLink>
          {isAdmin(user) && (
            <NavLink to="/users">
              <Icon name="users" size={16} /> Users
            </NavLink>
          )}
          {isSuperAdmin(user) && (
            <NavLink to="/mail">
              <Icon name="mail" size={16} /> Mail
            </NavLink>
          )}
        </nav>
        <ProfileMenu
          user={user}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onLogout={handleLogout}
        />
      </header>
      <main className={`content${wide ? " content-wide" : ""}`}>
        <Outlet />
      </main>
      <WhatsNew key={user?.id} user={user} />
    </div>
  );
}
