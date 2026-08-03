import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import Icon from "../components/Icon.jsx";
import UploadStep from "../components/UploadStep.jsx";
import MappingStep from "../components/MappingStep.jsx";
import CleanStep from "../components/CleanStep.jsx";
import ReviewStep from "../components/ReviewStep.jsx";

const STEPS = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Map" },
  { key: "clean", label: "Clean" },
  { key: "review", label: "Review & save" },
];
const KEYS = STEPS.map((s) => s.key);

// How many steps a file's saved status counts as fully completed.
const COMPLETED = { uploaded: 1, mapped: 2, cleaned: 3, committed: 4 };

export default function Branch() {
  const { branchId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [branch, setBranch] = useState(null);
  const [file, setFile] = useState(null);
  const [step, setStep] = useState("upload");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function deleteBranch() {
    setDeleting(true);
    setError("");
    try {
      await api(`/api/branches/${branchId}`, { method: "DELETE" });
      navigate("/");
    } catch (err) {
      setError(err.message);
      setDeleting(false);
      setShowDelete(false);
    }
  }

  // The current step is owned by the user. We only auto-position it once,
  // on the first load of a branch — never again on later re-renders or when a
  // sub-step updates `file`. This is what keeps the wizard from "jumping".
  const positioned = useRef(false);

  useEffect(() => {
    positioned.current = false;
    setLoading(true);
    setError("");
    let alive = true;

    (async () => {
      try {
        // One request, one DB session: branch + its current file together.
        const ws = await api(`/api/branches/${branchId}/workspace`);
        if (!alive) return;
        setBranch(ws.branch);
        const f = ws.file || null;
        setFile(f);

        if (!positioned.current) {
          // Resume on the first step that still needs the user.
          const done = f ? COMPLETED[f.status] ?? 0 : 0;
          setStep(KEYS[Math.min(done, STEPS.length - 1)]);
          positioned.current = true;
        }
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [branchId]);

  const completed = file ? COMPLETED[file.status] ?? 0 : 0;
  // Furthest step index the saved status entitles the user to open.
  const reach = Math.min(completed, STEPS.length - 1);
  const currentIndex = KEYS.indexOf(step);
  const pct = Math.round((completed / STEPS.length) * 100);

  // Navigation is locked: revisit completed steps freely, but never skip ahead
  // of what the data supports.
  function go(idx) {
    if (idx <= reach) setStep(KEYS[idx]);
  }

  if (loading) {
    return (
      <section>
        <div className="crumbs">
          <Link to="/">Branches</Link> <span>/</span>{" "}
          <span className="sk sk-line" style={{ width: 120, display: "inline-block", height: 12 }} />
        </div>
        {/* Show the wizard chrome immediately so the page never looks frozen. */}
        <div className="wiz">
          <div className="wiz-bar">
            <span style={{ width: "8%" }} />
          </div>
          <div className="stepper">
            {STEPS.map((s, i) => (
              <button key={s.key} type="button" className="step" disabled>
                <span className="num">{i + 1}</span>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="card" style={{ display: "grid", gap: "0.9rem" }}>
          <div className="sk sk-line" style={{ width: "40%", height: 22 }} />
          <div className="sk sk-line" style={{ width: "65%" }} />
          <div className="sk sk-bar" style={{ height: 180, marginTop: "0.5rem" }} />
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="crumbs crumbs-row">
        <div>
          <Link to="/">Branches</Link> <span>/</span>{" "}
          <strong>{branch ? branch.name : "…"}</strong>
        </div>
        {(user?.role === "admin" || user?.role === "superuser") && branch && (
          <button className="btn sm danger" onClick={() => setShowDelete(true)}>
            <Icon name="trash" size={14} /> Delete branch
          </button>
        )}
      </div>

      {showDelete && (
        <div className="save-overlay" onClick={() => setShowDelete(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-spark danger">
              <Icon name="trash" size={22} />
            </div>
            <h3>Delete this branch?</h3>
            <p className="muted">
              This permanently removes <strong>{branch?.name}</strong>, its
              uploaded files and any master records saved from it. This cannot be
              undone.
            </p>
            <div className="confirm-actions">
              <button
                className="btn sm"
                onClick={() => setShowDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button className="btn sm danger" onClick={deleteBranch} disabled={deleting}>
                <Icon name="trash" size={15} />
                {deleting ? "Deleting…" : "Delete branch"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overall progress + locked linear stepper */}
      <div className="wiz">
        <div className="wiz-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="stepper">
          {STEPS.map((s, i) => {
            const done = i < completed;
            const active = step === s.key;
            const locked = i > reach;
            return (
              <button
                key={s.key}
                type="button"
                className={`step ${active ? "active" : ""} ${done ? "done" : ""}`}
                disabled={locked}
                title={locked ? "Finish the earlier steps first" : undefined}
                onClick={() => go(i)}
              >
                <span className="num">
                  {done ? <Icon name="check" size={13} /> : i + 1}
                </span>
                {s.label}
                {locked && <Icon name="lock" size={12} className="step-lock" />}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      )}

      {step === "upload" && (
        <UploadStep
          branchId={branchId}
          existing={file}
          onUploaded={(f) => {
            setFile(f);
            setStep("map");
          }}
        />
      )}
      {step === "map" && file && (
        <MappingStep
          file={file}
          onSaved={(f) => setFile(f)}
          onNext={() => setStep("clean")}
        />
      )}
      {step === "clean" && file && (
        <CleanStep
          file={file}
          onCleaned={(f) => setFile(f)}
          onReview={() => setStep("review")}
        />
      )}
      {step === "review" && file && (
        <ReviewStep file={file} onCommitted={(f) => setFile(f)} />
      )}
    </section>
  );
}
