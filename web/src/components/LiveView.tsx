interface LiveViewProps {
  frameBase64: string | null;
}

export function LiveView({ frameBase64 }: LiveViewProps): JSX.Element {
  return (
    <section className="card live-view">
      <h2>Live View</h2>
      {frameBase64 ? (
        <img
          src={`data:image/jpeg;base64,${frameBase64}`}
          alt="Live browser frame"
          className="live-frame"
        />
      ) : (
        <div className="placeholder">Waiting for FRAME events...</div>
      )}
    </section>
  );
}
