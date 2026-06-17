import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import Icon from "../components/Icon.jsx";

const FEATURES = [
  {
    icon: "sparkles",
    title: "Auto-clean in seconds",
    text: "Junk characters, dates, durations and casing — fixed automatically.",
  },
  {
    icon: "table",
    title: "Map to your master format",
    text: "Smart column matching against your canonical schema.",
  },
  {
    icon: "shield",
    title: "Nothing saved until it's clean",
    text: "Review every flagged cell before a single row hits the database.",
  },
];

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function trackCaps(e) {
    // getModifierState reflects the live Caps Lock state on every keystroke.
    setCapsOn(e.getModifierState && e.getModifierState("CapsLock"));
  }

  return (
    <div className="auth-shell">
      {/* Brand showcase (hidden on small screens) */}
      <aside className="auth-aside">
        <div className="auth-aurora" aria-hidden="true">
          <span className="blob b1" />
          <span className="blob b2" />
          <span className="blob b3" />
        </div>
        <div className="auth-aside-inner">
          <div className="auth-brand">
            <img
              src="/logo.png"
              alt="MRM Cleanser"
              className="brand-logo brand-logo-chip"
            />
          </div>
          <h1 className="auth-hero">
            Turn messy vendor sheets into <em>spotless</em> master data.
          </h1>
          <p className="auth-hero-sub">
            The data-cleaning workspace built for music &amp; rights metadata —
            validate, fix and standardize thousands of rows without the busywork.
          </p>

          <ul className="auth-features">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="feat-icon">
                  <Icon name={f.icon} size={18} />
                </span>
                <div>
                  <strong>{f.title}</strong>
                  <span>{f.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Sign-in form */}
      <main className="auth-panel">
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-brand auth-brand-sm">
            <img src="/logo.png" alt="MRM Cleanser" className="brand-logo" />
          </div>

          <div className="auth-head">
            <h2>Welcome back</h2>
            <p className="muted small">Sign in to clean and standardize your data.</p>
          </div>

          {error && (
            <div className="alert" role="alert">
              <Icon name="alert" size={16} />
              {error}
            </div>
          )}

          <label className="field">
            <span className="field-label">Email</span>
            <span className="field-control">
              <Icon name="mail" size={17} className="field-icon" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="you@company.com"
                required
                autoFocus
              />
            </span>
          </label>

          <label className="field">
            <span className="field-label">Password</span>
            <span className="field-control">
              <Icon name="lock" size={17} className="field-icon" />
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={trackCaps}
                onKeyDown={trackCaps}
                autoComplete="current-password"
                placeholder="••••••••"
                required
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? "Hide password" : "Show password"}
                title={showPw ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                <Icon name={showPw ? "eyeOff" : "eye"} size={18} />
              </button>
            </span>
            {capsOn && (
              <span className="caps-hint">
                <Icon name="alert" size={13} /> Caps Lock is on
              </span>
            )}
          </label>

          <button
            className="btn primary auth-submit"
            type="submit"
            disabled={busy}
          >
            {busy ? (
              <>
                <span className="btn-spinner" /> Signing in…
              </>
            ) : (
              <>
                Sign in <Icon name="arrowRight" size={16} />
              </>
            )}
          </button>

          <p className="muted small auth-foot">
            <Icon name="lock" size={12} />
            Accounts are created by an administrator. There is no public sign-up.
          </p>
        </form>
      </main>
    </div>
  );
}
