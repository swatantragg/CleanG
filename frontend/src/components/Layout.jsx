import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import Icon from "./Icon.jsx";

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
          {user?.role === "admin" && (
            <NavLink to="/users">
              <Icon name="users" size={16} /> Users
            </NavLink>
          )}
        </nav>
        <div className="user-box">
          <button
            className="btn ghost sm theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
          </button>
          <div className="avatar">{initials(user?.full_name)}</div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span className="user-name">{user?.full_name}</span>
            <span className="role-pill" style={{ alignSelf: "flex-start" }}>
              {user?.role}
            </span>
          </div>
          <button className="btn ghost sm" onClick={handleLogout} title="Log out">
            <Icon name="logout" size={16} />
          </button>
        </div>
      </header>
      <main className={`content${wide ? " content-wide" : ""}`}>
        <Outlet />
      </main>
    </div>
  );
}
