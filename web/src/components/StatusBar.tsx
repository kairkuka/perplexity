import type { AgentStatus, StateEvent } from "@agent/shared";

type ConnectionStatus = "CONNECTING" | "CONNECTED" | "DISCONNECTED";

interface StatusBarProps {
  connection: ConnectionStatus;
  state: StateEvent;
}

const STATUS_CLASS: Record<AgentStatus, string> = {
  IDLE: "status-idle",
  RUNNING: "status-running",
  PAUSED: "status-paused",
  NEEDS_USER: "status-needs-user",
  WAITING_APPROVAL: "status-paused",
  DONE: "status-done",
  ERROR: "status-error",
};

export function StatusBar({ connection, state }: StatusBarProps): JSX.Element {
  return (
    <section className="card status-bar">
      <div>
        <strong>Connection:</strong> {connection}
      </div>
      <div>
        <strong>Status:</strong>{" "}
        <span className={STATUS_CLASS[state.status]}>{state.status}</span>
      </div>
      <div>
        <strong>Step:</strong> {state.step ?? "-"}
      </div>
      <div>
        <strong>Message:</strong> {state.message ?? "-"}
      </div>
    </section>
  );
}
