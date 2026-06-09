/* ============================================================
   Authentication — sign in / register (real users table)
   ============================================================ */
import React, { useState } from "react";
import { Icon } from "../components/ui.jsx";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function Authentication({ onLogin, onRegister }) {
  const [mode, setMode] = useState("login"); // login | register
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [errors, setErrors] = useState({});
  const [topErr, setTopErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const isReg = mode === "register";

  function submit() {
    if (busy) return;
    const e = {};
    if (isReg && !name.trim()) e.name = "Name is required.";
    if (!email.trim()) e.email = "Email is required."; else if (!EMAIL_RE.test(email.trim())) e.email = "Enter a valid email address.";
    if (!password) e.password = "Password is required."; else if (isReg && password.length < 8) e.password = "Use at least 8 characters.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setTopErr(null); setBusy(true);
    const action = isReg ? onRegister({ name: name.trim(), email: email.trim(), password: password }) : onLogin(email.trim(), password);
    Promise.resolve(action).then(function (err) { setBusy(false); if (err) setTopErr(err); });
  }
  function onKey(ev) { if (ev.key === "Enter") submit(); }
  function swap() { setMode(isReg ? "login" : "register"); setErrors({}); setTopErr(null); }

  return React.createElement("div", { className: "auth" },
    React.createElement("div", { className: "auth-brand" },
      React.createElement("div", { className: "auth-grid" }),
      React.createElement("div", { className: "auth-brand-top" },
        React.createElement("span", { className: "auth-logo" },
          React.createElement("span", { className: "dot" }), "G-Cleanser")),
      React.createElement("div", { className: "auth-brand-mid" },
        React.createElement("h1", null, "One messy catalog in.", React.createElement("br", null), "One trusted list out."),
        React.createElement("p", null, "Create a branch, upload your catalog files, run the cleanse, and share the cleaned output with your team. Branches expire and are purged automatically.")),
      React.createElement("ul", { className: "auth-feats" },
        featLine("Your branches, under your account"),
        featLine("Source files in, one cleaned file out"),
        featLine("Share cleaned outputs across the team")),
      React.createElement("div", { className: "auth-brand-foot" }, "Goongoonalo · Music Catalog Data Cleansing")),
    React.createElement("div", { className: "auth-form-wrap" },
      React.createElement("div", { className: "auth-card" },
        React.createElement("div", { className: "auth-mobile-logo" }, React.createElement("span", { className: "dot" }), "G-Cleanser"),
        React.createElement("h2", { className: "auth-h" }, isReg ? "Create your account" : "Welcome back"),
        React.createElement("p", { className: "auth-sub" }, isReg ? "Register to start cleansing catalogs." : "Sign in to pick up your branches where you left off."),
        topErr ? React.createElement("div", { className: "auth-toperr" }, React.createElement(Icon, { name: "alert", size: 15 }), topErr) : null,
        isReg ? field("Name", React.createElement("input", {
          className: "tinput" + (errors.name ? " err" : ""), placeholder: "Your name", value: name,
          onChange: function (e) { setName(e.target.value); }, onKeyDown: onKey, autoFocus: true,
        }), errors.name) : null,
        field("Email", React.createElement("input", {
          className: "tinput" + (errors.email ? " err" : ""), placeholder: "you@goongoonalo.com", type: "email", value: email,
          onChange: function (e) { setEmail(e.target.value); }, onKeyDown: onKey, autoFocus: !isReg,
        }), errors.email),
        field("Password", React.createElement("div", { className: "pw-wrap" },
          React.createElement("input", {
            className: "tinput" + (errors.password ? " err" : ""), placeholder: isReg ? "At least 8 characters" : "Your password",
            type: showPw ? "text" : "password", value: password,
            onChange: function (e) { setPassword(e.target.value); }, onKeyDown: onKey, style: { paddingRight: 44 },
          }),
          React.createElement("button", { type: "button", className: "pw-toggle", "aria-label": showPw ? "Hide password" : "Show password",
            onClick: function () { setShowPw(!showPw); } }, React.createElement(Icon, { name: showPw ? "eyeOff" : "eye", size: 17 }))), errors.password),
        React.createElement("button", { className: "btn pri auth-submit", onClick: submit, disabled: busy },
          busy ? (isReg ? "Creating…" : "Signing in…") : (isReg ? "Create account" : "Sign in"),
          React.createElement(Icon, { name: "arrowR", size: 16 })),
        React.createElement("div", { className: "auth-swap", style: { marginTop: 18, fontSize: 13.5, textAlign: "center", color: "var(--ink-3)" } },
          isReg ? "Already have an account? " : "New here? ",
          React.createElement("button", { className: "linkbtn", onClick: swap, style: { color: "var(--accent-ink)", background: "none", border: "none", cursor: "pointer", font: "inherit", fontWeight: 600 } },
            isReg ? "Sign in" : "Create an account")))));
}

function field(label, input, err) {
  return React.createElement("div", { className: "auth-field", key: label },
    React.createElement("label", { className: "field-label" }, label), input,
    err ? React.createElement("div", { className: "field-err" }, err) : null);
}
function featLine(t) {
  return React.createElement("li", { key: t },
    React.createElement("span", { className: "fk" }, React.createElement(Icon, { name: "check", size: 13 })), t);
}
