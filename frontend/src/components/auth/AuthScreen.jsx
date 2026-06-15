// Login / Signup screen. Signup collects name + confirm-password; password
// fields have a show/hide toggle.

import { useState } from "react";
import { useAuth } from "../../context/AuthContext";

const EyeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

function PasswordField({ label, value, onChange, autoComplete, placeholder, error }) {
  const [show, setShow] = useState(false);
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label>{label}</label>
      <div className="pwfield">
        <input
          type={show ? "text" : "password"}
          className={error ? "bad" : ""}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required
        />
        <button
          type="button"
          className="eyebtn"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          title={show ? "Hide password" : "Show password"}
        >
          {show ? EyeOffIcon : EyeIcon}
        </button>
      </div>
      {error && <div className="why">{error}</div>}
    </div>
  );
}

export default function AuthScreen() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isSignup = mode === "signup";
  const mismatch = isSignup && confirm.length > 0 && confirm !== password;

  const switchMode = () => {
    setMode(isSignup ? "login" : "signup");
    setError("");
    setConfirm("");
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");

    if (isSignup) {
      if (!name.trim()) return setError("Please enter your name");
      if (password !== confirm) return setError("Passwords do not match");
    }

    setBusy(true);
    try {
      if (isSignup) await signup(email.trim(), password, name.trim());
      else await login(email.trim(), password);
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="authwrap">
      <div className="authcard">
        <div className="brand" style={{ padding: "0 0 20px" }}>
          <div className="mark">M</div>
          <div>
            <div className="t" style={{ color: "var(--ink)" }}>MRM-CleanUp</div>
            <div className="s" style={{ color: "var(--faint)" }}>workflow console</div>
          </div>
        </div>

        <h1 style={{ fontSize: 25, marginBottom: 4 }}>{isSignup ? "Create your account" : "Welcome back"}</h1>
        <p className="lede" style={{ margin: "0 0 18px" }}>
          {isSignup ? "Sign up to start cleaning catalogues." : "Log in to continue to the console."}
        </p>

        <form onSubmit={submit}>
          {isSignup && (
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Name</label>
              <input
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your full name"
                required
              />
            </div>
          )}

          <div className="field" style={{ marginBottom: 14 }}>
            <label>Email</label>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>

          <PasswordField
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSignup ? "new-password" : "current-password"}
            placeholder={isSignup ? "At least 6 characters" : "Your password"}
          />

          {isSignup && (
            <PasswordField
              label="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              placeholder="Re-enter your password"
              error={mismatch ? "Passwords do not match" : ""}
            />
          )}

          {error && (
            <div className="note" style={{ marginBottom: 14, color: "#9F1239", background: "#FFF1F2", borderColor: "#FECDD3" }}>
              <span>!</span>
              <span>{error}</span>
            </div>
          )}

          <button
            className="btn"
            type="submit"
            disabled={busy || mismatch}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {busy ? "Please wait…" : isSignup ? "Create account" : "Log in"}
          </button>
        </form>

        <div style={{ marginTop: 16, fontSize: 14.5, color: "var(--muted)", textAlign: "center" }}>
          {isSignup ? "Already have an account?" : "New here?"}{" "}
          <button className="linkbtn" onClick={switchMode}>
            {isSignup ? "Log in" : "Create one"}
          </button>
        </div>
      </div>
    </div>
  );
}
