import {
  parseInboundJson,
  serializeMessage,
  type OutboundMessage,
} from "@agent/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { RuntimeConfig } from "../config.js";
import { AgentController } from "../agent/agentController.js";

interface ClientSocket extends WebSocket {
  isAlive?: boolean;
  controller?: AgentController;
}

export class RuntimeWsServer {
  private readonly wss: WebSocketServer;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(private readonly config: RuntimeConfig) {
    this.wss = new WebSocketServer({
      host: config.wsHost,
      port: config.wsPort,
    });
  }

  start(): void {
    this.wss.on("connection", (socket: WebSocket) => {
      this.handleConnection(socket as ClientSocket);
    });

    this.wss.on("listening", () => {
      console.log(`WS server listening on ws://${this.config.wsHost}:${this.config.wsPort}`);
    });

    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    const closePromises = Array.from(this.wss.clients).map(async (socket) => {
      const client = socket as ClientSocket;
      await client.controller?.dispose();
      client.close();
    });

    await Promise.all(closePromises);

    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleConnection(socket: ClientSocket): void {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    const controller = new AgentController(
      {
        emit: (message) => {
          this.send(socket, message);
        },
      },
      this.config,
    );

    socket.controller = controller;

    socket.on("message", (raw: RawData) => {
      void this.handleInboundMessage(socket, raw);
    });

    socket.on("close", () => {
      void controller.dispose();
    });

    socket.on("error", (error: Error) => {
      this.send(socket, {
        type: "ERROR",
        code: "WS_SOCKET_ERROR",
        message: error.message,
      });
    });

    this.send(socket, {
      type: "STATE",
      status: "IDLE",
      message: "Connected to runtime",
    });

    this.send(socket, {
      type: "LOG",
      level: "info",
      ts: Date.now(),
      message: "WebSocket client connected",
    });
  }

  private async handleInboundMessage(socket: ClientSocket, raw: RawData): Promise<void> {
    let messageText: string;

    if (typeof raw === "string") {
      messageText = raw;
    } else if (Buffer.isBuffer(raw)) {
      messageText = raw.toString("utf-8");
    } else {
      this.sendProtocolError(socket, "Unsupported WS payload type");
      return;
    }

    let inbound;
    try {
      inbound = parseInboundJson(messageText);
    } catch {
      this.sendProtocolError(socket, "Malformed WS message");
      return;
    }

    const controller = socket.controller;
    if (!controller) {
      this.sendProtocolError(socket, "Controller is not initialized");
      return;
    }

    switch (inbound.type) {
      case "RUN":
        controller.run(inbound.command);
        return;
      case "RESUME":
        controller.resume();
        return;
      case "STOP":
        await controller.stop();
        return;
      case "APPROVE":
        controller.approve();
        return;
      case "DENY":
        controller.deny();
        return;
      default:
        this.sendProtocolError(socket, "Unsupported message type");
    }
  }

  private send(socket: WebSocket, message: OutboundMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(serializeMessage(message));
  }

  private sendProtocolError(socket: WebSocket, message: string): void {
    this.send(socket, {
      type: "ERROR",
      code: "WS_PROTOCOL_ERROR",
      message,
    });

    this.send(socket, {
      type: "LOG",
      level: "error",
      ts: Date.now(),
      message,
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.wss.clients) {
        const client = socket as ClientSocket;

        if (client.isAlive === false) {
          client.terminate();
          continue;
        }

        client.isAlive = false;
        client.ping();
      }
    }, 15000);
  }
}
