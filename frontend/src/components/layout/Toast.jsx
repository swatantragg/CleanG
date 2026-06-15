// Transient bottom-centre notification.

export default function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="toast">
      <span className="dot" style={{ background: "#34D399" }}></span>
      {message}
    </div>
  );
}
