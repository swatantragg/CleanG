import { useMemo, useState } from "react";
import { api } from "../api/client.js";
import Icon from "./Icon.jsx";

const METHOD_LABELS = {
  exact: { text: "Exact", cls: "m-exact", icon: "check" },
  synonym: { text: "Matched", cls: "m-synonym", icon: "check" },
  fuzzy: { text: "Similar", cls: "m-fuzzy", icon: "alert" },
  content: { text: "By data", cls: "m-content", icon: "table" },
  manual: { text: "Manual", cls: "m-manual", icon: "check" },
  unmatched: { text: "Blank", cls: "m-unmatched", icon: null },
};

export default function MappingStep({ file, onSaved, onNext }) {
  // Editable copy: master column -> chosen primary input header (or "").
  const [choices, setChoices] = useState(() =>
    Object.fromEntries(file.mapping.map((m) => [m.master_column, m.input_header || ""]))
  );
  // master column -> extra input headers feeding the SAME master column.
  const [extras, setExtras] = useState(() =>
    Object.fromEntries(
      file.mapping.map((m) => [m.master_column, [...(m.extra_headers || [])]])
    )
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(file.status === "mapped");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState({ attention: true, matched: false, blank: false });

  const original = useMemo(
    () => Object.fromEntries(file.mapping.map((m) => [m.master_column, m])),
    [file.mapping]
  );

  // How each row should be classified *right now*, given live edits.
  function rowState(masterCol) {
    const chosen = choices[masterCol];
    const orig = original[masterCol];
    const unchanged = chosen === (orig.input_header || "");
    if (!chosen) return { bucket: "blank", method: "unmatched", review: false, conf: 0 };
    if (unchanged && orig.needs_review)
      return { bucket: "attention", method: "fuzzy", review: true, conf: orig.confidence };
    const method = unchanged ? orig.method : "manual";
    return { bucket: "matched", method, review: false, conf: unchanged ? orig.confidence : 1 };
  }

  const usedCounts = useMemo(() => {
    const c = {};
    Object.values(choices).forEach((h) => h && (c[h] = (c[h] || 0) + 1));
    Object.values(extras).forEach((list) =>
      list.forEach((h) => h && (c[h] = (c[h] || 0) + 1))
    );
    return c;
  }, [choices, extras]);

  const buckets = useMemo(() => {
    const b = { attention: [], matched: [], blank: [] };
    file.mapping.forEach((m) => b[rowState(m.master_column).bucket].push(m));
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices, file.mapping]);

  const total = file.mapping.length;
  const matchedCount = buckets.matched.length + buckets.attention.length;
  const pct = Math.round((matchedCount / total) * 100);
  const contentCount = file.mapping.filter((m) => m.method === "content").length;
  const trulyUnused = file.headers.filter((h) => !usedCounts[h]);

  function setChoice(master, header) {
    setChoices((c) => ({ ...c, [master]: header }));
    setSaved(false);
  }

  function addExtra(master) {
    setExtras((e) => ({ ...e, [master]: [...(e[master] || []), ""] }));
    setSaved(false);
  }

  function setExtra(master, idx, header) {
    setExtras((e) => {
      const list = [...(e[master] || [])];
      list[idx] = header;
      return { ...e, [master]: list };
    });
    setSaved(false);
  }

  function removeExtra(master, idx) {
    setExtras((e) => {
      const list = [...(e[master] || [])];
      list.splice(idx, 1);
      return { ...e, [master]: list };
    });
    setSaved(false);
  }

  async function save() {
    setError("");
    setBusy(true);
    try {
      const assignments = Object.fromEntries(
        Object.entries(choices).map(([m, h]) => [m, h || null])
      );
      // Only send non-empty extra sources; the backend de-dupes against the primary.
      const extra = Object.fromEntries(
        Object.entries(extras)
          .map(([m, list]) => [m, list.filter(Boolean)])
          .filter(([, list]) => list.length > 0)
      );
      const updated = await api(`/api/files/${file.id}/mapping`, {
        method: "PUT",
        body: { assignments, extra },
      });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Options for a column <select>. Headers already mapped to another column get a
  // ✓ marker (but stay selectable — a column can feed more than one master).
  function columnOptions(current) {
    return file.headers.map((h) => {
      const usedElsewhere = (usedCounts[h] || 0) > (h === current ? 1 : 0);
      return (
        <option key={h} value={h}>
          {usedElsewhere ? "✓ " : ""}
          {h}
        </option>
      );
    });
  }

  function matchQuery(m) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      m.master_column.toLowerCase().includes(q) ||
      (choices[m.master_column] || "").toLowerCase().includes(q)
    );
  }

  function Row({ m }) {
    const st = rowState(m.master_column);
    const chosen = choices[m.master_column];
    const collision = chosen && usedCounts[chosen] > 1;
    const label = METHOD_LABELS[st.method] || METHOD_LABELS.manual;
    const showConf = st.method === "fuzzy" || st.method === "content";
    const title =
      st.method === "content"
        ? "Matched from the column's data, not just its name"
        : st.method === "fuzzy"
        ? "Closest name match — please confirm"
        : undefined;
    return (
      <div className={`map-row ${collision ? "collision" : ""}`}>
        <div className="master">
          <span className="pos">{m.position}</span>
          {m.master_column}
        </div>
        <Icon name="arrowRight" size={15} className="arrow" />
        <div>
          <select
            value={chosen}
            onChange={(e) => setChoice(m.master_column, e.target.value)}
          >
            <option value="">— leave blank —</option>
            {columnOptions(chosen)}
          </select>
          {collision && <div className="collision-note">used more than once</div>}

          {/* Extra input columns merged into this same master column. */}
          {(extras[m.master_column] || []).map((h, idx) => (
            <div key={idx} className="extra-source">
              <span className="extra-plus">+</span>
              <select
                value={h}
                onChange={(e) => setExtra(m.master_column, idx, e.target.value)}
              >
                <option value="">— choose a column —</option>
                {columnOptions(h)}
              </select>
              <button
                type="button"
                className="extra-remove"
                title="Remove this column"
                onClick={() => removeExtra(m.master_column, idx)}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}

          {chosen && (
            <button
              type="button"
              className="extra-add"
              onClick={() => addExtra(m.master_column)}
            >
              <Icon name="plus" size={12} /> Add another column
            </button>
          )}
        </div>
        <span className={`method-badge ${label.cls}`} title={title}>
          {label.icon && <Icon name={label.icon} size={12} />}
          {label.text}
          {showConf && ` ${Math.round(st.conf * 100)}%`}
        </span>
      </div>
    );
  }

  function Section({ id, title, items, tone }) {
    const visible = items.filter(matchQuery);
    if (items.length === 0) return null;
    return (
      <div className="section">
        <button
          className={`section-head ${tone || ""} ${open[id] ? "open" : ""}`}
          onClick={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
        >
          {title}
          <span className="count">{items.length}</span>
          <Icon name="arrowRight" size={16} className="chev" />
        </button>
        {open[id] && visible.map((m) => <Row key={m.master_column} m={m} />)}
        {open[id] && visible.length === 0 && (
          <div className="map-row">
            <span className="muted small">No matches for “{query}”.</span>
          </div>
        )}
      </div>
    );
  }

  const allGood = buckets.attention.length === 0;

  return (
    <div>
      <div className="page-head" style={{ marginBottom: "1rem" }}>
        <div>
          <h1>Map columns to master</h1>
          <p className="muted">
            {file.original_name} · {file.n_rows} rows · {file.n_columns} columns
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.6rem" }}>
          <button className="btn" onClick={save} disabled={busy}>
            {busy ? (
              "Saving…"
            ) : saved ? (
              <>
                <Icon name="check" size={16} /> Saved
              </>
            ) : (
              "Save mapping"
            )}
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              if (!saved) await save();
              onNext?.();
            }}
            disabled={busy}
          >
            Continue to cleaning <Icon name="arrowRight" size={16} />
          </button>
        </div>
      </div>

      {error && (
        <div className="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      )}
      {file.warnings?.length > 0 && (
        <div className="warn">
          <Icon name="alert" size={16} />
          {file.warnings.join(" ")}
        </div>
      )}

      {/* Hero summary with progress ring */}
      <div className="map-hero">
        <div className="ring" style={{ "--p": pct }}>
          <div className="ring-inner">{pct}%</div>
        </div>
        <div className="map-hero-text">
          <h2>
            {allGood
              ? `We matched ${matchedCount} of ${total} columns automatically`
              : `${buckets.attention.length} column${
                  buckets.attention.length > 1 ? "s" : ""
                } need a quick check`}
          </h2>
          <p>
            {allGood
              ? `Everything looks confident${
                  contentCount
                    ? ` — ${contentCount} matched from the data itself`
                    : ""
                }. Review the matches below and save.`
              : "We weren’t fully sure on these — confirm or change them, then save."}
          </p>
        </div>
        <div className="map-hero-stats">
          <div>
            <div className="num" style={{ color: "var(--green)" }}>
              {matchedCount}
            </div>
            <div className="lbl">Mapped</div>
          </div>
          <div>
            <div className="num" style={{ color: "var(--amber)" }}>
              {buckets.attention.length}
            </div>
            <div className="lbl">To check</div>
          </div>
          <div>
            <div className="num" style={{ color: "var(--muted)" }}>
              {buckets.blank.length}
            </div>
            <div className="lbl">Blank</div>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input
            placeholder="Find a column…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <Section
        id="attention"
        tone="attention"
        title="Needs your attention"
        items={buckets.attention}
      />
      <Section id="matched" title="Auto-matched" items={buckets.matched} />
      <Section id="blank" title="Will be left blank" items={buckets.blank} />

      {trulyUnused.length > 0 && (
        <div className="card unused">
          <strong>Unused input columns:</strong> {trulyUnused.join(", ")}
          <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
            These exist in your file but have no place in the master format — they
            won’t appear in the output.
          </p>
        </div>
      )}
    </div>
  );
}
