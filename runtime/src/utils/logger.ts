import type { LogEvent } from "@agent/shared";

export type LogLevel = LogEvent["level"];

export function createLogEvent(level: LogLevel, message: string): LogEvent {
  return {
    type: "LOG",
    level,
    ts: Date.now(),
    message,
  };
}

export function formatConsoleLog(level: LogLevel, message: string): string {
  return `[runtime:${level}] ${message}`;
}
