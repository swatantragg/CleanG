/* ============================================================
   G-Cleanser — app shell. API-driven, minimal lifecycle model:
   branches (active/expired/deleted) own source + cleaned files.
   ============================================================ */
import React, { useState, useEffect, useCallback } from "react";
import { api } from "./api/index.js";
import { Icon, Avatar } from "./components/ui.jsx";
import { Authentication } from "./screens/Authentication.jsx";
import { BranchDashboard } from "./screens/BranchDashboard.jsx";
import { BranchDetail } from "./screens/BranchDetail.jsx";
import { BranchHistory } from "./screens/BranchHistory.jsx";
import { SharedBrowser } from "./screens/SharedBrowser.jsx";
import { initials } from "./util.js";

const NAV_TITLE = { dashboard: "Branches", shared: "Shared Branches", history: "Branch History", branch: "Branch" };

function initialTheme() {
  try { const s = localStorage.getItem("gc-theme"); if (s === "dark" || s === "light") return s; } catch (e) {}
  try { if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark"; } catch (e) {}
  return "light";
}

export default function App() {
  const [boot, setBoot] = useState("loading");
  const [me, setMe] = useState(null);
  const [presets, setPresets] = useState([]);
  const [branches, setBranches] = useState([]);
  const [view, setView] = useState({ name: "dashboard", branchId: null });
  const [userMenu, setUserMenu] = useState(false);
  const [toast, setToast] = useState(null);
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("gc-theme", theme); } catch (e) {} }, [theme]);
  // NOTE: the accent ramp lives in styles.css (with per-theme dark overrides). Don't set
  // it inline on <html> — inline styles beat :root[data-theme="dark"] and break dark mode.
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2800); return () => clearTimeout(t); }, [toast]);

  const load = useCallback(() => Promise.all([api.presets.list(), api.branches.list()]).then(([p, b]) => { setPresets(p); setBranches(b); }), []);

  useEffect(() => {
    let on = true;
    if (!api.hasToken()) { setBoot("auth"); return; }
    api.auth.me().then((u) => { if (!on) return; setMe(u); return load(); })
      .then(() => { if (on) setBoot("ready"); })
      .catch(() => { if (on) { api.setToken(null); setBoot("auth"); } });
    return () => { on = false; };
  }, [load]);

  function go(name, branchId) { setView({ name, branchId: branchId || null }); setUserMenu(false); }
  function openBranch(id) { go("branch", id); }
  function refresh() { return api.branches.list().then(setBranches); }

  function login(email, pw) {
    return api.auth.login(email, pw)
      .then((r) => { setMe(r.user); return load().then(() => { go("dashboard"); setBoot("ready"); return null; }); })
      .catch((e) => e.message || "Sign in failed.");
  }
  function register(body) {
    return api.auth.register(body)
      .then((r) => { setMe(r.user); return load().then(() => { go("dashboard"); setBoot("ready"); return null; }); })
      .catch((e) => e.message || "Sign up failed.");
  }
  function signOut() { api.setToken(null); setMe(null); setBranches([]); setPresets([]); go("dashboard"); setBoot("auth"); }

  function createBranch(body) { return api.branches.create(body).then((b) => { setBranches((l) => [b, ...l]); return b; }); }
  function patchBranch(b) { setBranches((l) => l.map((x) => (x.id === b.id ? b : x))); return b; }
  function deleteBranch(id) { return api.branches.remove(id).then((b) => { patchBranch(b); setToast("Branch deleted — files purge after expiry."); return b; }); }

  const ctx = { me, presets, branches, go, openBranch, refresh, createBranch, deleteBranch, patchBranch, toast: setToast };

  if (boot === "loading") {
    return (
      <div className="app-boot" style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--ink-3)" }}>
        <div className="spin" /><span>Loading workspace…</span>
      </div>
    );
  }
  if (boot === "auth" || !me) return <Authentication onLogin={login} onRegister={register} />;

  const meUser = { ...me, initials: initials(me.name), hue: 285 };
  const activeBranch = view.name === "branch" ? branches.find((b) => b.id === view.branchId) : null;

  let Screen = null;
  if (view.name === "dashboard") Screen = <BranchDashboard ctx={ctx} />;
  else if (view.name === "shared") Screen = <SharedBrowser ctx={ctx} />;
  else if (view.name === "history") Screen = <BranchHistory ctx={ctx} />;
  else if (view.name === "branch") Screen = <BranchDetail ctx={ctx} branchId={view.branchId} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sb-brand"><span className="dot" /><span className="nm">G-Cleanser</span></div>
        <div className="sb-scroll">
          <div className="sb-group">
            <div className="sb-label">Workspace</div>
            <button className={"sb-item" + (view.name === "dashboard" ? " active" : "")} onClick={() => go("dashboard")}>
              <Icon name="dashboard" size={17} className="ico" /><span>Branches</span>
            </button>
            <button className={"sb-item" + (view.name === "shared" ? " active" : "")} onClick={() => go("shared")}>
              <Icon name="cross" size={17} className="ico" /><span>Shared Branches</span>
            </button>
            <button className={"sb-item" + (view.name === "history" ? " active" : "")} onClick={() => go("history")}>
              <Icon name="clock" size={17} className="ico" /><span>Branch History</span>
            </button>
          </div>
          {activeBranch ? (
            <div className="sb-group">
              <div className="sb-label">Open branch</div>
              <div className="sb-branchctx">
                <div className="t">Open</div>
                <div className="b">{activeBranch.name}</div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="sb-user" style={{ position: "relative" }}>
          {userMenu ? (
            <div className="usermenu">
              <div className="um-head"><div className="n">{meUser.name}</div><div className="e">{meUser.email || ""}</div></div>
              <div className="um-div" />
              <button className="signout" onClick={signOut}><Icon name="lock" size={15} /><span>Sign out</span></button>
            </div>
          ) : null}
          <button className="sb-userbtn" onClick={() => setUserMenu(!userMenu)}>
            <Avatar user={meUser} size={32} />
            <div className="meta"><div className="n">{meUser.name}</div><div className="r">{meUser.email}</div></div>
            <Icon name={userMenu ? "chevronUp" : "chevron"} size={16} className="chev" />
          </button>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="crumb">
            <span>Workspace</span>
            <span className="sep">/</span>
            <span className="cur">{activeBranch ? activeBranch.name : NAV_TITLE[view.name]}</span>
          </div>
          <div className="right">
            <button className="theme-tog" role="switch" aria-checked={theme === "dark"}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              <span className="tt-knob" />
              <span className="tt-ic tt-sun"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg></span>
              <span className="tt-ic tt-moon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg></span>
            </button>
            <Avatar user={meUser} size={30} />
          </div>
        </div>
        <div className="content">{Screen}</div>
      </div>

      {toast ? <div className="toast"><Icon name="check" size={15} />{toast}</div> : null}
    </div>
  );
}
