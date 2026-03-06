import type {
  InboundMessage,
  NeedApprovalEvent,
  OutboundMessage,
  ResultEvent,
  StateEvent,
} from "@agent/shared";
import { useEffect, useRef, useState } from "react";

import { ApprovalModal } from "./components/ApprovalModal";
import { CommandBar } from "./components/CommandBar";
import { Controls } from "./components/Controls";
import { LiveView } from "./components/LiveView";
import { StatusBar } from "./components/StatusBar";
import { StepLog } from "./components/StepLog";
import { createWsClient, WsClient } from "./wsClient";

type ConnectionStatus = "CONNECTING" | "CONNECTED" | "DISCONNECTED";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  ts: number;
  message: string;
}

const MAX_LOGS = 200;
const WS_URL = "ws://localhost:8787";

const initialState: StateEvent = {
  type: "STATE",
  status: "IDLE",
  message: "Waiting for runtime",
};

function pushLog(current: LogEntry[], next: LogEntry): LogEntry[] {
  const merged = [...current, next];
  return merged.slice(-MAX_LOGS);
}

export default function App(): JSX.Element {
  const wsClientRef = useRef<WsClient | null>(null);

  const [connection, setConnection] = useState<ConnectionStatus>("CONNECTING");
  const [command, setCommand] = useState<string>("open https://example.com");
  const [stateEvent, setStateEvent] = useState<StateEvent>(initialState);
  const [frameBase64, setFrameBase64] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [approval, setApproval] = useState<NeedApprovalEvent | null>(null);
  const [results, setResults] = useState<ResultEvent[]>([]);

  useEffect(() => {
    const client = createWsClient(WS_URL, {
      onOpen: () => {
        setConnection("CONNECTED");
      },
      onClose: () => {
        setConnection("DISCONNECTED");
      },
      onMessage: (message: OutboundMessage) => {
        handleOutboundMessage(message);
      },
      onProtocolError: (message: string) => {
        setLogs((current) =>
          pushLog(current, {
            level: "error",
            ts: Date.now(),
            message,
          }),
        );
      },
    });

    wsClientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      wsClientRef.current = null;
    };
  }, []);

  const send = (message: InboundMessage): void => {
    wsClientRef.current?.send(message);
  };

  const handleOutboundMessage = (message: OutboundMessage): void => {
    switch (message.type) {
      case "STATE":
        setStateEvent(message);
        return;
      case "LOG":
        setLogs((current) => pushLog(current, message));
        return;
      case "FRAME":
        setFrameBase64(message.dataBase64);
        return;
      case "NEED_APPROVAL":
        setApproval(message);
        setLogs((current) =>
          pushLog(current, {
            level: "warn",
            ts: Date.now(),
            message: `Approval needed: ${message.reason}`,
          }),
        );
        return;
      case "ERROR":
        setStateEvent({
          type: "STATE",
          status: "ERROR",
          message: `${message.code}: ${message.message}`,
        });
        setLogs((current) =>
          pushLog(current, {
            level: "error",
            ts: Date.now(),
            message: `${message.code}: ${message.message}`,
          }),
        );
        return;
      case "RESULT":
        setResults((current) => [...current, message]);
        return;
      default:
    }
  };

  const isWsDisconnected = connection !== "CONNECTED";

  return (
    <div className="app-shell">
      <h1>Blink Desktop Web Agent</h1>

      <CommandBar
        command={command}
        onCommandChange={setCommand}
        onRun={() => {
          setResults([]);
          send({ type: "RUN", command });
        }}
        disabled={isWsDisconnected}
      />

      <StatusBar connection={connection} state={stateEvent} />

      {stateEvent.status === "NEEDS_USER" ? (
        <div className="needs-user-banner">
          Complete the action manually in Chrome and click Resume.
        </div>
      ) : null}

      <div className="grid">
        <LiveView frameBase64={frameBase64} />
        <StepLog logs={logs} />
      </div>

      <div className="card results">
        <h2>Results</h2>
        {results.length === 0 ? <div>No structured results yet.</div> : null}
        {results.map((result, index) => (
          <div key={`${result.kind}-${index}`}>
            <strong>{result.kind}</strong>: {result.kind === "snapshot"
              ? `${result.snapshot?.elements.length ?? 0} elements @ ${result.snapshot?.url ?? "unknown"}`
              : result.value}
          </div>
        ))}
      </div>

      <Controls
        disabled={isWsDisconnected}
        onResume={() => {
          send({ type: "RESUME" });
        }}
        onStop={() => {
          send({ type: "STOP" });
        }}
      />

      <ApprovalModal
        approval={approval}
        onApprove={() => {
          send({ type: "APPROVE" });
          setApproval(null);
        }}
        onDeny={() => {
          send({ type: "DENY" });
          setApproval(null);
        }}
      />
    </div>
  );
}
