interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  ts: number;
  message: string;
}

interface StepLogProps {
  logs: LogEntry[];
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function StepLog({ logs }: StepLogProps): JSX.Element {
  return (
    <section className="card step-log">
      <h2>Step Log</h2>
      <ul>
        {logs.map((entry, index) => (
          <li key={`${entry.ts}-${index}`} className={`log-${entry.level}`}>
            <span className="log-ts">{formatTs(entry.ts)}</span>
            <span className="log-level">{entry.level.toUpperCase()}</span>
            <span>{entry.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
