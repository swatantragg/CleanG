// Left navigation rail: brand and the 7 gated workflow steps.

export default function Sidebar({ steps, step, setStep }) {
  return (
    <aside className="rail">
      <div className="brand">
        <div className="mark">M</div>
        <div>
          <div className="t">MRM-CleanUp</div>
          <div className="s">workflow console</div>
        </div>
      </div>

      {steps.map((s, i) => (
        <button
          key={i}
          className={"step" + (step === i ? " active" : "") + (s.done ? " done" : "")}
          disabled={!s.enabled}
          onClick={() => s.enabled && setStep(i)}
        >
          <span className="n">{s.done ? "✓" : i + 1}</span>
          <span>
            <span className="lbl">{s.t}</span>
            <div className="sub">{s.s}</div>
          </span>
        </button>
      ))}

      <div className="railfoot">
        MRM-CleanUp · workflow console
        <br />
        Sign in required · data stored in Postgres.
      </div>
    </aside>
  );
}
