// Top metrics strip: input / clean / review / master / dupes counts.

export default function StatsBar({ master, clean, review, raw, dedup }) {
  const items = [
    { k: "Input rows",    v: raw.length,                c: "var(--ink)" },
    { k: "Clean",         v: clean ? clean.length : "—", c: "var(--teal)" },
    { k: "In review",     v: review ? review.length : "—", c: "var(--amber)" },
    { k: "Master DB",     v: master.length,             c: "var(--emerald)" },
    { k: "Dupes skipped", v: dedup.length,              c: "var(--rose)" },
  ];
  return (
    <div className="stats">
      {items.map((s, i) => (
        <div className="stat" key={i}>
          <div className="v" style={{ color: s.c }}>{s.v}</div>
          <div className="k">{s.k}</div>
        </div>
      ))}
    </div>
  );
}
