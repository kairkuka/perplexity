import { z } from "zod";

export const AgentStatusSchema = z.enum([
  "IDLE",
  "RUNNING",
  "PAUSED",
  "NEEDS_USER",
  "WAITING_APPROVAL",
  "DONE",
  "ERROR",
]);

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const InboundRunSchema = z.object({
  type: z.literal("RUN"),
  command: z.string().min(1),
});

export const InboundResumeSchema = z.object({ type: z.literal("RESUME") });
export const InboundStopSchema = z.object({ type: z.literal("STOP") });

export const InboundApproveSchema = z.object({ type: z.literal("APPROVE") });
export const InboundDenySchema = z.object({ type: z.literal("DENY") });

export const InboundMessageSchema = z.discriminatedUnion("type", [
  InboundRunSchema,
  InboundResumeSchema,
  InboundStopSchema,
  InboundApproveSchema,
  InboundDenySchema,
]);

export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const StateEventSchema = z.object({
  type: z.literal("STATE"),
  status: AgentStatusSchema,
  step: z.string().optional(),
  message: z.string().optional(),
});

export const FrameEventSchema = z.object({
  type: z.literal("FRAME"),
  ts: z.number(),
  mime: z.literal("image/jpeg"),
  dataBase64: z.string(),
});

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const LogEventSchema = z.object({
  type: z.literal("LOG"),
  level: LogLevelSchema,
  ts: z.number(),
  message: z.string(),
});

export const NeedApprovalEventSchema = z.object({
  type: z.literal("NEED_APPROVAL"),
  reason: z.string(),
  step: z.object({ type: z.string() }).passthrough().optional(),
});

export const ErrorEventSchema = z.object({
  type: z.literal("ERROR"),
  code: z.string(),
  message: z.string(),
});

export const SnapshotElementSchema = z.object({
  id: z.number(),
  tag: z.string(),
  text: z.string().optional(),
  aria: z.string().optional(),
  role: z.string().optional(),
  href: z.string().optional(),
});

export const SnapshotPayloadSchema = z.object({
  url: z.string(),
  title: z.string(),
  elements: z.array(SnapshotElementSchema),
});

export const ResultTextEventSchema = z.object({
  type: z.literal("RESULT"),
  kind: z.enum(["url", "title", "text"]),
  value: z.string(),
});

export const ResultSnapshotEventSchema = z.object({
  type: z.literal("RESULT"),
  kind: z.literal("snapshot"),
  snapshot: SnapshotPayloadSchema,
});

export const ResultEventSchema = z.union([
  ResultTextEventSchema,
  ResultSnapshotEventSchema,
]);

export const OutboundMessageSchema = z.union([
  StateEventSchema,
  FrameEventSchema,
  LogEventSchema,
  NeedApprovalEventSchema,
  ErrorEventSchema,
  ResultTextEventSchema,
  ResultSnapshotEventSchema,
]);

export type StateEvent = z.infer<typeof StateEventSchema>;
export type FrameEvent = z.infer<typeof FrameEventSchema>;
export type LogEvent = z.infer<typeof LogEventSchema>;
export type NeedApprovalEvent = z.infer<typeof NeedApprovalEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type ResultEvent = z.infer<typeof ResultEventSchema>;
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
export type WsMessage = InboundMessage | OutboundMessage;

export function parseInboundMessage(raw: unknown): InboundMessage {
  return InboundMessageSchema.parse(raw);
}

export function parseOutboundMessage(raw: unknown): OutboundMessage {
  return OutboundMessageSchema.parse(raw);
}

export function parseInboundJson(raw: string): InboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  return parseInboundMessage(parsed);
}

export function parseOutboundJson(raw: string): OutboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  return parseOutboundMessage(parsed);
}

export function serializeMessage(message: WsMessage): string {
  return JSON.stringify(message);
}
